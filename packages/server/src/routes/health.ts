import { Hono } from "hono";
import type { CatalogStatus, HealthResponse, ReadyResponse } from "@traveler/shared";
import { env, VERSION } from "../env.ts";
import { catalogCounts, searchIndexSize } from "../db/catalog.ts";
import { lastSync } from "../sync/catalog.ts";
import { isSyncRunning, runSyncOnce } from "../sync/scheduler.ts";
import { departureSubscriberCount } from "../services/departures.ts";
import { vehicleSubscriberCount, vehiclePositionsAvailable } from "../services/vehicles.ts";

export const health = new Hono();

const startedAt = Date.now();

function catalogStatus(): CatalogStatus {
  const counts = catalogCounts();
  const last = lastSync("sites");
  return {
    ...counts,
    lastSyncAt: last?.finished_at ?? null,
    lastSyncStatus: last ? (last.status === "ok" ? "ok" : "failed") : "never",
    lastSyncError: last?.error ?? null,
    lastChange: last
      ? { added: last.added, updated: last.updated, removed: last.removed }
      : null,
    syncRunning: isSyncRunning(),
  };
}

health.get("/health", (c) => {
  const body: HealthResponse = {
    ok: true,
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    catalog: catalogStatus(),
    realtime: {
      vehiclePositions: vehiclePositionsAvailable(),
      subscribers: departureSubscriberCount() + vehicleSubscriberCount(),
    },
  };
  return c.json(body);
});

/**
 * Manual catalog refresh, for when SL publishes a timetable change mid-day.
 *
 * Registered only when ADMIN_TOKEN is configured, and guarded by it. The work is a
 * ~10 MB download across four upstream endpoints plus a full rewrite of three tables;
 * left open, a deployment on a public URL would hand that to anyone who found the path.
 *
 * Returns 202 rather than blocking: the sync takes tens of seconds, longer than most
 * proxies will hold a response open, and the outcome is readable from /api/health.
 */
if (env.ADMIN_TOKEN) {
  health.post("/catalog/sync", (c) => {
    const offered = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!timingSafeEqual(offered, env.ADMIN_TOKEN!)) {
      return c.json({ error: { code: "unauthorized", message: "Invalid admin token." } }, 401);
    }

    if (isSyncRunning()) {
      return c.json(
        { queued: false, reason: "A catalog sync is already running.", catalog: catalogStatus() },
        409,
      );
    }

    // Not awaited: the caller gets an acknowledgement, /api/health reports the result.
    void runSyncOnce("manual trigger");
    return c.json({ queued: true, catalog: catalogStatus() }, 202);
  });
}

/**
 * Readiness, as distinct from liveness.
 *
 * `/api/health` answers 200 from the moment the process is up, deliberately: on a first
 * deploy the catalog is empty and filling it takes a few seconds, and a platform health
 * check that failed during that window would kill the container mid-sync, forever.
 *
 * That makes it the wrong signal for anything that needs the catalog to actually work.
 * A caller that waits on `/api/health` and then searches for a stop gets nothing back
 * and no error. `/api/ready` answers 503 until the catalog is queryable: stops loaded,
 * the search index built, and the derived pass finished. The e2e suite waits on this.
 */
function readiness(): ReadyResponse {
  const counts = catalogCounts();
  const indexed = searchIndexSize();
  const derived = lastSync("derived");

  const reasons: string[] = [];
  if (counts.sites === 0) reasons.push("catalog has no stops");
  if (indexed === 0) reasons.push("search index is empty");
  if (derived?.status !== "ok") reasons.push("no completed derived sync");

  return {
    ready: reasons.length === 0,
    reasons,
    syncRunning: isSyncRunning(),
    sites: counts.sites,
    indexed,
  };
}

health.get("/ready", (c) => {
  const status = readiness();
  return c.json(status, status.ready ? 200 : 503);
});

/** Constant-time compare so the endpoint does not leak the token a character at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
