import type { TransportMode } from "@traveler/shared";
import { db } from "./index.ts";

export type TripInfo = {
  /** SL's line gid, e.g. 9011001044300000: the same id the journey planner calls `globalId`. */
  routeId: string;
  line: string;
  mode: TransportMode;
  headsign: string | null;
  directionId: number | null;
};

/**
 * GTFS route types onto our modes.
 * https://gtfs.org/documentation/schedule/reference/#routestxt
 */
export function modeFromRouteType(routeType: number | null | undefined): TransportMode {
  switch (routeType) {
    case 0:
    case 900:
      return "TRAM";
    case 1:
    case 401:
      return "METRO";
    case 2:
    case 100:
    case 109:
      return "TRAIN";
    case 3:
    case 700:
      return "BUS";
    case 4:
    case 1000:
    case 1200:
      return "SHIP";
    case 7:
      return "TRAIN"; // funicular
    default:
      return "UNKNOWN";
  }
}

const tripQuery = db.query<
  { route_id: string; short_name: string; route_type: number; headsign: string | null; direction_id: number | null },
  [string]
>(
  `SELECT t.route_id, r.short_name, r.route_type, t.headsign, t.direction_id
     FROM gtfs_trips t JOIN gtfs_routes r ON r.route_id = t.route_id
    WHERE t.trip_id = ?1`,
);

/** What a trip id is, in words: the line, its mode, where it is heading. */
export function tripInfo(tripId: string): TripInfo | null {
  const row = tripQuery.get(tripId);
  if (!row) return null;
  return {
    routeId: row.route_id,
    line: row.short_name,
    mode: modeFromRouteType(row.route_type),
    headsign: row.headsign,
    directionId: row.direction_id,
  };
}

const countQuery = db.query<{ routes: number; trips: number }, []>(
  `SELECT (SELECT COUNT(*) FROM gtfs_routes) AS routes, (SELECT COUNT(*) FROM gtfs_trips) AS trips`,
);

export function gtfsCounts() {
  return countQuery.get() ?? { routes: 0, trips: 0 };
}
