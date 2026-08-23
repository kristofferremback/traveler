import type { Isochrone, Neighbourhood, NeighbourStop, TransportMode, WalkSettings } from "@traveler/shared";
import { db } from "../db/index.ts";
import { cached } from "../db/cache.ts";
import { stopPointsNear } from "../db/catalog.ts";
import { modeFromStopAreaType } from "../sl/modes.ts";
import { walkIsochrones, walkMatrix, walkRoutes, type MatrixCell } from "../routing/valhalla.ts";
import { ascentDescent, walkSeconds } from "../lib/walk.ts";
import { logger } from "../lib/log.ts";

const log = logger("neighbourhood");

/**
 * The walking neighbourhood of a coordinate: every stop point you could reasonably walk
 * to, with the street facts of getting there.
 *
 * Computed once per coordinate and stored, because it costs a handful of rate-limited
 * routing calls and changes only when the street network or the stop catalog does.
 * What *is* cheap -- minutes at a given speed, the cut-off -- is derived on every read
 * from the caller's settings, so changing your walking speed never recomputes anything.
 *
 * Why a real routing engine and not crow-fly: around Jarlaberg, Skvaltan is 406 m away
 * and 864 m to walk, Blockhusudden is 1 070 m away and 14 km to walk (water), and the
 * Nacka strand pier is 250 m further than its bus stop plus a 58 m climb. Crow-fly gets
 * all three wrong in ways that would recommend the wrong stop.
 */

/** Crow-fly radius for candidates. Walks are rarely more than 1.6× the straight line. */
const CANDIDATE_RADIUS_M = 2200;
/** Street distance beyond which a stop is not stored. 30 min at 6 km/h on the flat. */
const MAX_STORED_METRES = 3000;
/** Cap on candidates sent to the matrix, nearest first. Two matrix requests. */
const MAX_CANDIDATES = 100;
const MATRIX_CHUNK = 50;
/** Stored neighbourhoods older than this are recomputed on next read. */
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
/** Speed used for the routing calls themselves. Irrelevant to distance; fixed so the cache key is not speed-dependent. */
const ROUTING_SPEED_KMH = 6;

type StoredStop = {
  stopPointId: number;
  siteId: number;
  siteGid: string;
  name: string;
  mode: TransportMode;
  lat: number;
  lon: number;
  metres: number;
  ascentTo: number;
  ascentFrom: number;
  path: [number, number][];
};

type Stored = { lat: number; lon: number; stops: StoredStop[]; computedAt: string };

const selectStored = db.query<{ body: string; computed_at: string }, [string]>(
  "SELECT body, computed_at FROM neighbourhoods WHERE centre_key = ?1",
);
const upsertStored = db.query(
  `INSERT INTO neighbourhoods (centre_key, lat, lon, body, computed_at) VALUES (?1, ?2, ?3, ?4, ?5)
   ON CONFLICT(centre_key) DO UPDATE SET body = excluded.body, computed_at = excluded.computed_at`,
);

/** ~1 m precision: the same front door always maps to one stored neighbourhood. */
export function centreKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

const inFlight = new Map<string, Promise<Stored>>();

async function compute(lat: number, lon: number): Promise<Stored> {
  const started = Date.now();
  const near = stopPointsNear(lat, lon, CANDIDATE_RADIUS_M);

  // One stop point per stop area: the two sides of a bus stop are a road width apart,
  // and the matrix budget is better spent on distinct places to board.
  const byArea = new Map<number | string, (typeof near)[number]>();
  for (const p of near) {
    const key = p.stop_area_id ?? `pt:${p.id}`;
    if (!byArea.has(key)) byArea.set(key, p);
  }
  const candidates = [...byArea.values()].slice(0, MAX_CANDIDATES);

  const cells: MatrixCell[] = [];
  for (let i = 0; i < candidates.length; i += MATRIX_CHUNK) {
    const chunk = candidates.slice(i, i + MATRIX_CHUNK);
    cells.push(...(await walkMatrix({ lat, lon }, chunk, ROUTING_SPEED_KMH)));
  }

  const reachable = candidates
    .map((p, i) => ({ p, cell: cells[i] ?? null }))
    .filter((x): x is { p: (typeof candidates)[number]; cell: NonNullable<MatrixCell> } =>
      x.cell !== null && x.cell.metres <= MAX_STORED_METRES,
    );

  const routes = await walkRoutes(
    reachable.map(({ p }) => ({ from: { lat, lon }, to: { lat: p.lat, lon: p.lon } })),
    ROUTING_SPEED_KMH,
  );

  const stops: StoredStop[] = [];
  let ferries = 0;
  for (let i = 0; i < reachable.length; i++) {
    const { p } = reachable[i]!;
    const route = routes[i]!;
    // A route that boards a ferry is not a walk, whatever the engine calls it.
    if (route.viaFerry) {
      ferries++;
      continue;
    }
    const { ascent, descent } = ascentDescent(route.elevation);
    stops.push({
      stopPointId: p.id,
      siteId: p.site_id,
      siteGid: p.site_gid,
      name: p.site_name,
      mode: modeFromStopAreaType(p.stop_area_type),
      lat: p.lat,
      lon: p.lon,
      metres: route.metres,
      ascentTo: Math.round(ascent),
      // The walk back is the same path reversed, so its climb is this one's descent.
      ascentFrom: Math.round(descent),
      path: route.path,
    });
  }
  stops.sort((a, b) => a.metres - b.metres);

  const stored: Stored = { lat, lon, stops, computedAt: new Date().toISOString() };
  upsertStored.run(centreKey(lat, lon), lat, lon, JSON.stringify(stored), stored.computedAt);
  log.info(
    `computed neighbourhood ${centreKey(lat, lon)}: ${candidates.length} candidates, ${stops.length} walkable, ${ferries} ferry-only, ${Date.now() - started}ms`,
  );
  return stored;
}

async function loadOrCompute(lat: number, lon: number): Promise<Stored> {
  const key = centreKey(lat, lon);
  const row = selectStored.get(key);
  if (row && Date.now() - new Date(row.computed_at).getTime() < MAX_AGE_MS) {
    try {
      return JSON.parse(row.body) as Stored;
    } catch {
      log.warn(`discarding unparseable neighbourhood ${key}`);
    }
  }
  let pending = inFlight.get(key);
  if (!pending) {
    pending = compute(lat, lon).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

function derive(stop: StoredStop, settings: WalkSettings): NeighbourStop {
  return {
    ...stop,
    secondsTo: walkSeconds(stop.metres, stop.ascentTo, settings.speedKmh),
    secondsFrom: walkSeconds(stop.metres, stop.ascentFrom, settings.speedKmh),
  };
}

/**
 * The stops within the caller's walking range of a coordinate, nearest-in-minutes
 * first. A stop is in range if it can be reached *or* left within the limit, because
 * the climb makes the two differ and either direction is a reason to keep it.
 */
export async function getNeighbourhood(
  lat: number,
  lon: number,
  settings: WalkSettings,
  opts: { isochrones?: boolean } = {},
): Promise<Neighbourhood> {
  const stored = await loadOrCompute(lat, lon);
  const limit = settings.maxWalkMinutes * 60;
  // One entry per site and mode: trips are asked per site, and the walk that matters is
  // to the nearest point where that mode actually stops. The Nacka strand site has three
  // pier stop areas within 150 m of each other; one is enough.
  const nearestPerSiteMode = new Map<string, StoredStop>();
  for (const s of stored.stops) {
    const key = `${s.siteId}:${s.mode}`;
    const held = nearestPerSiteMode.get(key);
    if (!held || s.metres < held.metres) nearestPerSiteMode.set(key, s);
  }
  const stops = [...nearestPerSiteMode.values()]
    .map((s) => derive(s, settings))
    .filter((s) => Math.min(s.secondsTo, s.secondsFrom) <= limit)
    .sort((a, b) => a.secondsTo - b.secondsTo);

  const isochrones = opts.isochrones ? await getIsochrones(lat, lon, settings) : [];

  return { lat, lon, settings, stops, isochrones, computedAt: stored.computedAt };
}

/** Contours every 5 minutes up to the limit, for drawing the neighbourhood on a map. */
async function getIsochrones(lat: number, lon: number, settings: WalkSettings): Promise<Isochrone[]> {
  const minutes: number[] = [];
  for (let m = 5; m <= settings.maxWalkMinutes && minutes.length < 4; m += 5) minutes.push(m);
  if (minutes.length === 0 || minutes[minutes.length - 1] !== settings.maxWalkMinutes) {
    minutes.push(settings.maxWalkMinutes);
  }
  return cached(
    `isochrone:${centreKey(lat, lon)}:${settings.speedKmh}:${minutes.join("-")}`,
    30 * 24 * 3600,
    () => walkIsochrones({ lat, lon }, minutes, settings.speedKmh),
  );
}

/** Forget a stored neighbourhood so the next read recomputes it. */
export function invalidateNeighbourhood(lat: number, lon: number): void {
  db.query("DELETE FROM neighbourhoods WHERE centre_key = ?1").run(centreKey(lat, lon));
}
