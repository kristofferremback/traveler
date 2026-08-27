import { unzipSync } from "fflate";
import { db } from "../db/index.ts";
import { env } from "../env.ts";
import { getBuffer } from "../sl/http.ts";
import { logger } from "../lib/log.ts";
import { runStep, lastSync } from "./catalog.ts";
import { gtfsCounts } from "../db/gtfs.ts";

const log = logger("gtfs");

const ZIP = "https://opendata.samtrafiken.se/gtfs/sl/sl.zip";

/**
 * SL's static GTFS, reduced to what names a vehicle.
 *
 * The realtime feeds carry a trip id and nothing else a person can read; `trips.txt`
 * turns that into a route and a headsign, `routes.txt` into a line number and a mode.
 * The zip is about 50 MB and `stop_times.txt` is most of it; only the two files we
 * need are inflated, and the bytes are gone when the transaction commits.
 */
export function gtfsStaticKey(): string | undefined {
  return env.TRAFIKLAB_GTFS_STATIC_KEY ?? env.TRAFIKLAB_GTFS_RT_KEY;
}

/** Why a sync is due, or null: empty tables, or older than the catalog interval. */
export function gtfsSyncReason(scheduled: boolean): string | null {
  if (!gtfsStaticKey()) return null;
  if (gtfsCounts().trips === 0) return "no gtfs trips loaded";
  if (scheduled) return "scheduled";
  const last = lastSync("gtfs");
  if (!last || last.status !== "ok" || !last.finished_at) return "no successful gtfs sync on record";
  const ageMs = Date.now() - new Date(last.finished_at).getTime();
  if (ageMs > env.CATALOG_SYNC_INTERVAL_MS) return `gtfs is ${Math.round(ageMs / 3_600_000)}h old`;
  return null;
}

/**
 * One GTFS CSV file as rows keyed by header. Fields may be quoted and a quoted field
 * may hold commas and doubled quotes; nothing here needs more than that.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  let header: string[] | null = null;
  let field = "";
  let record: string[] = [];
  let quoted = false;
  const push = () => {
    record.push(field);
    field = "";
  };
  const end = () => {
    push();
    if (record.length === 1 && record[0] === "") {
      record = [];
      return;
    }
    if (!header) header = record.map((h) => h.replace(/^﻿/, "").trim());
    else {
      const row: Record<string, string> = {};
      header.forEach((key, i) => (row[key] = record[i] ?? ""));
      rows.push(row);
    }
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") push();
    else if (c === "\n") end();
    else if (c !== "\r") field += c;
  }
  if (field !== "" || record.length > 0) end();
  return rows;
}

const insertRoute = db.query(
  `INSERT INTO gtfs_routes (route_id, short_name, route_type, agency_id) VALUES (?1, ?2, ?3, ?4)`,
);
const insertTrip = db.query(
  `INSERT INTO gtfs_trips (trip_id, route_id, headsign, direction_id, service_id)
   VALUES (?1, ?2, ?3, ?4, ?5)`,
);

const int = (v: string | undefined): number | null => (v === undefined || v === "" ? null : Number(v));

export function replaceGtfs(routes: Record<string, string>[], trips: Record<string, string>[]) {
  db.run(`DELETE FROM gtfs_trips`);
  db.run(`DELETE FROM gtfs_routes`);
  for (const r of routes) {
    insertRoute.run(
      r["route_id"] ?? "",
      r["route_short_name"] || r["route_long_name"] || "",
      Number(r["route_type"] ?? -1),
      r["agency_id"] || null,
    );
  }
  for (const t of trips) {
    insertTrip.run(
      t["trip_id"] ?? "",
      t["route_id"] ?? "",
      t["trip_headsign"] || null,
      int(t["direction_id"]),
      t["service_id"] || null,
    );
  }
  return { added: routes.length + trips.length, updated: 0, removed: 0 };
}

export async function syncGtfs() {
  const key = gtfsStaticKey();
  if (!key) return null;
  const started = Date.now();
  const bytes = await getBuffer(ZIP, {
    upstream: "trafiklab/gtfs-static",
    query: { key },
    accept: "application/zip",
    timeoutMs: 120_000,
    retries: 1,
  });
  const wanted = new Set(["routes.txt", "trips.txt"]);
  const files = unzipSync(bytes, { filter: (f) => wanted.has(f.name) });
  const decoder = new TextDecoder();
  const routes = parseCsv(decoder.decode(files["routes.txt"] ?? new Uint8Array()));
  const trips = parseCsv(decoder.decode(files["trips.txt"] ?? new Uint8Array()));
  if (routes.length === 0 || trips.length === 0) {
    throw new Error(`gtfs zip had ${routes.length} routes and ${trips.length} trips; keeping the previous tables`);
  }
  log.info(`gtfs zip ${Math.round(bytes.length / 1e6)} MB: ${routes.length} routes, ${trips.length} trips, ${Date.now() - started}ms`);
  return runStep("gtfs", () => db.transaction(() => replaceGtfs(routes, trips))());
}
