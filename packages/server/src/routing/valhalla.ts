import { env, VERSION } from "../env.ts";
import { UpstreamError, describe } from "../lib/errors.ts";
import { logger } from "../lib/log.ts";

const log = logger("valhalla");

/**
 * Pedestrian routing against a Valhalla server -- by default the public FOSSGIS
 * instance, which asks for at most one request per second per client and an
 * identifying header. Both are honoured here: every call goes through one queue that
 * spaces requests out, whatever the caller's concurrency.
 *
 * Only street facts come out of here: metres, elevation, shape, whether a ferry was
 * used. Minutes are the walk model's job (`lib/walk.ts`), because they depend on who
 * is walking and Valhalla's pedestrian costing ignores hills.
 */

const CLIENT_ID = "traveler";
const MIN_INTERVAL_MS = 1100;

let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function throttled<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    lastRequestAt = Date.now();
    return work();
  });
  queue = run.catch(() => undefined);
  return run;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const url = `${env.VALHALLA_URL}${path}`;
  return throttled(async () => {
    const started = Bun.nanoseconds();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": `Traveler/${VERSION} (+personal SL journey planner)`,
          "x-client-id": CLIENT_ID,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new UpstreamError("valhalla", `valhalla unreachable: ${describe(err)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        "valhalla",
        `valhalla ${path} responded ${res.status}: ${text.slice(0, 300) || res.statusText}`,
        res.status === 400 ? 400 : 502,
      );
    }
    const json = (await res.json()) as T;
    log.debug(`${path} ok in ${Math.round((Bun.nanoseconds() - started) / 1e6)}ms`);
    return json;
  });
}

export type LatLon = { lat: number; lon: number };

function costing(speedKmh: number) {
  return {
    costing: "pedestrian",
    costing_options: {
      pedestrian: {
        walking_speed: speedKmh,
        // "Avoid" rather than "never": Valhalla will still take a ferry when nothing
        // else connects, so routes are checked for ferry manoeuvres afterwards.
        use_ferry: 0,
      },
    },
    units: "kilometers",
  };
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

type MatrixResponse = {
  sources_to_targets: { distance: number | null; time: number | null; to_index: number }[][];
};

export type MatrixCell = { metres: number; seconds: number } | null;

/**
 * Street distance from one point to many. Cheap -- one request for fifty targets --
 * but without elevation or shape, so it is the prefilter, not the answer.
 */
export async function walkMatrix(
  source: LatLon,
  targets: LatLon[],
  speedKmh: number,
): Promise<MatrixCell[]> {
  if (targets.length === 0) return [];
  const res = await post<MatrixResponse>("/sources_to_targets", {
    sources: [source],
    targets,
    ...costing(speedKmh),
  });
  const row = res.sources_to_targets[0] ?? [];
  return targets.map((_, i) => {
    const cell = row[i];
    if (!cell || cell.distance === null || cell.time === null) return null;
    return { metres: Math.round(cell.distance * 1000), seconds: Math.round(cell.time) };
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type RouteResponse = {
  trip: {
    legs: {
      summary: { length: number; time: number };
      shape: string;
      elevation?: number[];
      maneuvers: { type: number; ferry?: boolean }[];
    }[];
  };
};

export type WalkRoute = {
  metres: number;
  /** Elevation samples along the route, metres above sea level. */
  elevation: number[];
  viaFerry: boolean;
  /** [lon, lat] pairs. */
  path: [number, number][];
};

/** Elevation sample spacing in metres. 30 m resolves a stairway without bloating the payload. */
const ELEVATION_INTERVAL_M = 30;

/**
 * One street route per (from, to) pair. Pairs are packed into as few requests as the
 * server allows by chaining them as legs of one trip: A→B, C→D, ... become the legs of
 * the location list [A, B, C, D, ...]; the legs between pairs (B→C) are discarded.
 *
 * Public Valhalla caps a route at 20 locations, so 10 pairs per request.
 */
export async function walkRoutes(
  pairs: { from: LatLon; to: LatLon }[],
  speedKmh: number,
): Promise<WalkRoute[]> {
  const out: WalkRoute[] = [];
  const PER_REQUEST = 10;
  for (let i = 0; i < pairs.length; i += PER_REQUEST) {
    const chunk = pairs.slice(i, i + PER_REQUEST);
    const locations = chunk.flatMap((p) => [
      { ...p.from, type: "break" },
      { ...p.to, type: "break" },
    ]);
    const res = await post<RouteResponse>("/route", {
      locations,
      ...costing(speedKmh),
      elevation_interval: ELEVATION_INTERVAL_M,
    });
    const legs = res.trip.legs;
    for (let j = 0; j < chunk.length; j++) {
      // Leg 2j is the pair's own route; leg 2j+1 is the filler to the next pair.
      const leg = legs[j * 2];
      if (!leg) throw new UpstreamError("valhalla", "valhalla returned fewer legs than asked");
      out.push({
        metres: Math.round(leg.summary.length * 1000),
        elevation: leg.elevation ?? [],
        viaFerry: leg.maneuvers.some((m) => m.ferry === true),
        path: decodePolyline6(leg.shape),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Isochrones
// ---------------------------------------------------------------------------

type IsochroneResponse = {
  features: {
    properties: { contour: number };
    geometry: { type: "Polygon"; coordinates: [number, number][][] };
  }[];
};

export async function walkIsochrones(
  centre: LatLon,
  minutes: number[],
  speedKmh: number,
): Promise<{ minutes: number; rings: [number, number][][] }[]> {
  const res = await post<IsochroneResponse>("/isochrone", {
    locations: [centre],
    ...costing(speedKmh),
    contours: minutes.map((time) => ({ time })),
    polygons: true,
    denoise: 0.5,
    generalize: 15,
  });
  return res.features
    .filter((f) => f.geometry.type === "Polygon")
    .map((f) => ({ minutes: f.properties.contour, rings: f.geometry.coordinates }))
    .sort((a, b) => a.minutes - b.minutes);
}

// ---------------------------------------------------------------------------
// Polyline
// ---------------------------------------------------------------------------

/** Valhalla encodes shapes as Google polylines with 6 decimal precision, [lat, lon] order. */
export function decodePolyline6(encoded: string): [number, number][] {
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}
