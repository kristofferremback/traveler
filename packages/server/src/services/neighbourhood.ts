import type { Isochrone, Neighbourhood, NeighbourStop, TransportMode, WalkSettings } from "@traveler/shared";
import { db } from "../db/index.ts";
import { cached } from "../db/cache.ts";
import { stopPointsNear } from "../db/catalog.ts";
import { modeFromStopAreaType } from "../sl/modes.ts";
import { walkIsochrones, walkMatrix, walkRoutes, type MatrixCell } from "../routing/valhalla.ts";
import { degreeBox, haversineMetres } from "../lib/geo.ts";
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
/** Cap on candidates sent to the matrix, nearest first. One matrix request. */
const MAX_CANDIDATES = 100;
/** Targets per matrix request. The public instance answers a hundred in under a second. */
const MATRIX_CHUNK = 100;
/**
 * Cap on candidates that get a route of their own, nearest by street first.
 *
 * The matrix is one request for everything; a route is one request per ten, and each
 * request costs a second of the routing queue's spacing. A plan enumerates the twelve
 * nearest sites and reads one stop per site and mode, so the fortieth nearest stop area
 * is the last one any answer could be built from. Routing all hundred spent six more
 * requests on stops no plan ever read.
 */
const MAX_ROUTED = 40;
/** Stored neighbourhoods older than this are recomputed on next read. */
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
/**
 * How far a stored centre may be from the coordinate asked about and still answer for it.
 *
 * `centreKey` is a metre wide, and a phone's fix moves further than that standing still,
 * so an exact key meant every plan from Min position rebuilt the whole neighbourhood:
 * nine routing calls and about eight seconds before SL was asked anything. Fifty metres
 * is half a minute of walking, and it is added to every walk rather than ignored, so a
 * reused neighbourhood errs towards leaving early.
 */
const REUSE_RADIUS_M = 50;
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

const selectNearby = db.query<
  { lat: number; lon: number; body: string; computed_at: string },
  [number, number, number, number]
>(
  `SELECT lat, lon, body, computed_at FROM neighbourhoods
    WHERE lat BETWEEN ?1 AND ?2 AND lon BETWEEN ?3 AND ?4`,
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

/** A stored centre as the reuse rule sees it: where it is and how old it is. */
export type Centre = { lat: number; lon: number; computedAt: string };

/**
 * Which stored centre may answer for a coordinate: the nearest one inside the reuse
 * radius that has not aged out. Pure, so the rule can be read and tested without a
 * database or a routing engine.
 */
export function reusableCentre<T extends Centre>(
  stored: T[],
  lat: number,
  lon: number,
  now: number,
): { centre: T; offsetMetres: number } | null {
  let best: { centre: T; offsetMetres: number } | null = null;
  for (const centre of stored) {
    if (now - new Date(centre.computedAt).getTime() >= MAX_AGE_MS) continue;
    const offsetMetres = Math.round(haversineMetres(lat, lon, centre.lat, centre.lon));
    if (offsetMetres > REUSE_RADIUS_M) continue;
    if (!best || offsetMetres < best.offsetMetres) best = { centre, offsetMetres };
  }
  return best;
}

/**
 * The candidates worth a route of their own: reachable on foot, nearest by street
 * first, capped. The matrix answered for all of them; this decides which ones are also
 * worth the elevation and the shape.
 */
export function routable<T>(
  candidates: T[],
  cells: MatrixCell[],
): { candidate: T; metres: number }[] {
  return candidates
    .map((candidate, i) => ({ candidate, cell: cells[i] ?? null }))
    .filter((x) => x.cell !== null && x.cell.metres <= MAX_STORED_METRES)
    .map((x) => ({ candidate: x.candidate, metres: x.cell!.metres }))
    .sort((a, b) => a.metres - b.metres)
    .slice(0, MAX_ROUTED);
}

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

  const reachable = routable(candidates, cells);

  const routes = await walkRoutes(
    reachable.map(({ candidate }) => ({ from: { lat, lon }, to: { lat: candidate.lat, lon: candidate.lon } })),
    ROUTING_SPEED_KMH,
  );

  const stops: StoredStop[] = [];
  let ferries = 0;
  for (let i = 0; i < reachable.length; i++) {
    const p = reachable[i]!.candidate;
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
    `computed neighbourhood ${centreKey(lat, lon)}: ${candidates.length} candidates, ${reachable.length} routed, ${stops.length} walkable, ${ferries} ferry-only, ${Date.now() - started}ms`,
  );
  return stored;
}

/** A stored neighbourhood and how far its centre is from the coordinate asked about. */
type Loaded = { stored: Stored; offsetMetres: number };

async function loadOrCompute(lat: number, lon: number): Promise<Loaded> {
  const box = degreeBox(lat, lon, REUSE_RADIUS_M);
  const rows = selectNearby
    .all(box.minLat, box.maxLat, box.minLon, box.maxLon)
    .map((r) => ({ lat: r.lat, lon: r.lon, computedAt: r.computed_at, body: r.body }));
  const hit = reusableCentre(rows, lat, lon, Date.now());
  if (hit) {
    try {
      return { stored: JSON.parse(hit.centre.body) as Stored, offsetMetres: hit.offsetMetres };
    } catch {
      log.warn(`discarding unparseable neighbourhood ${centreKey(hit.centre.lat, hit.centre.lon)}`);
    }
  }

  const key = centreKey(lat, lon);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = compute(lat, lon).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return { stored: await pending, offsetMetres: 0 };
}

/**
 * A stored stop as this walker sees it, from wherever they actually are.
 *
 * `offsetMetres` is how far the stored centre is from the coordinate asked about. It is
 * added rather than ignored: the true walk is the stored one give or take the offset,
 * and the half of that range which makes someone leave a little early is the half that
 * catches the bus.
 */
function derive(stop: StoredStop, settings: WalkSettings, offsetMetres: number): NeighbourStop {
  const metres = stop.metres + offsetMetres;
  return {
    ...stop,
    metres,
    secondsTo: walkSeconds(metres, stop.ascentTo, settings.speedKmh),
    secondsFrom: walkSeconds(metres, stop.ascentFrom, settings.speedKmh),
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
  const { stored, offsetMetres } = await loadOrCompute(lat, lon);
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
    .map((s) => derive(s, settings, offsetMetres))
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
