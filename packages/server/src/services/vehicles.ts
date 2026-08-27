import type { VehiclePosition, VehiclesQuery, VehiclesResponse } from "@traveler/shared";
import { env } from "../env.ts";
import { bboxFromTuple, haversineMetres, withinBBox } from "../lib/geo.ts";
import { PollingHub } from "../realtime/hub.ts";
import { stopPointByGid } from "../db/catalog.ts";
import {
  fetchTripUpdates,
  fetchVehiclePositions,
  vehiclePositionsAvailable,
  type TripTimes,
  type TripUpdateFeed,
  type VehicleFeed,
} from "../sl/gtfsrt.ts";

export { vehiclePositionsAvailable };

/**
 * One poll for the whole network, filtered per subscriber.
 *
 * The feed is a single protobuf covering every SL vehicle, so there is nothing to gain
 * from per-viewport requests and a lot to lose: the free Trafiklab tier allows 30 000
 * calls a month, which one client at this interval would exhaust in about a day. The
 * hub stops polling entirely when nobody is watching, so the meter only runs while a
 * map is open.
 */
const feed = new PollingHub<VehicleFeed>(
  "vehicles",
  fetchVehiclePositions,
  env.VEHICLE_POLL_INTERVAL_MS,
);

/**
 * The timetable side, polled at a quarter of the pace: which trip a departure is does
 * not change from one second to the next, and this feed is as large as the other.
 */
const tripUpdates = new PollingHub<TripUpdateFeed>(
  "trip-updates",
  fetchTripUpdates,
  env.VEHICLE_POLL_INTERVAL_MS * 4,
);

/** A scheduled departure this close to the planner's is the same departure. */
const DEPARTURE_TOLERANCE_MS = 90_000;
/** A stop this close to the boarding coordinate is the boarding stop. */
const STOP_TOLERANCE_M = 250;

export type Departure = { lineGid: string; boardAt: number; lat: number; lon: number };

function departureOf(query: VehiclesQuery): Departure | null {
  if (!query.trip || !query.boardAt || query.boardLat === undefined || query.boardLon === undefined) {
    return null;
  }
  const boardAt = new Date(query.boardAt).getTime();
  const lineGid = query.trip.split(":")[0];
  if (!lineGid || Number.isNaN(boardAt)) return null;
  return { lineGid, boardAt, lat: query.boardLat, lon: query.boardLon };
}

/**
 * Which running trip is the departure the planner showed.
 *
 * The planner and the realtime feeds share the line gid and the timetable, nothing
 * else. So: among trips on that line, the one with a scheduled departure at a stop
 * near the boarding coordinate within a minute and a half of the planner's time.
 * Pure, so it can be tested with a fixture rather than against SL at rush hour.
 */
export function matchTrip(
  departure: Departure,
  trips: TripTimes[],
  locate: (stopId: string) => { lat: number; lon: number } | null = (gid) => {
    const p = stopPointByGid(gid);
    return p && p.lat !== null && p.lon !== null ? { lat: p.lat, lon: p.lon } : null;
  },
): string | null {
  let best: { tripId: string; off: number } | null = null;
  for (const trip of trips) {
    if (trip.routeId !== departure.lineGid) continue;
    for (const stop of trip.stops) {
      const off = Math.abs(stop.scheduledDeparture - departure.boardAt);
      if (off > DEPARTURE_TOLERANCE_MS) continue;
      const at = locate(stop.stopId);
      if (!at || haversineMetres(at.lat, at.lon, departure.lat, departure.lon) > STOP_TOLERANCE_M) continue;
      if (!best || off < best.off) best = { tripId: trip.tripId, off };
    }
  }
  return best?.tripId ?? null;
}

function filter(vehicles: VehiclePosition[], query: VehiclesQuery): VehiclePosition[] {
  const box = bboxFromTuple(query.bbox);
  const wantedModes = query.modes?.length ? new Set(query.modes) : null;
  const line = query.line?.trim();

  return vehicles.filter((v) => {
    if (!withinBBox(v.lat, v.lon, box)) return false;
    if (line && v.line !== line) return false;
    // Mode is UNKNOWN for a trip the static join does not know yet; a mode filter must
    // not hide the whole network on a fresh instance.
    if (wantedModes && v.mode !== "UNKNOWN" && !wantedModes.has(v.mode)) return false;
    return true;
  });
}

function toResponse(
  value: VehicleFeed | null,
  query: VehiclesQuery,
  error: string | null,
  matchedTrip: string | null,
): VehiclesResponse {
  if (!value) {
    return {
      vehicles: [],
      fetchedAt: new Date().toISOString(),
      available: vehiclePositionsAvailable(),
      reason: error ?? (vehiclePositionsAvailable() ? "Waiting for the first feed." : null),
      match: "none",
    };
  }
  const departure = departureOf(query);
  // The trip's own vehicle wins even outside the viewport: a bus still three suburbs
  // away is exactly what the traveller wants to see coming.
  const own = matchedTrip ? value.vehicles.filter((v) => v.tripId === matchedTrip) : [];
  return {
    vehicles: own.length > 0 ? own : filter(value.vehicles, query),
    fetchedAt: value.fetchedAt,
    available: value.available,
    // A stale-but-served feed still reports the error, so the UI can show both the
    // last known positions and the fact that they stopped updating.
    reason: error ?? value.reason,
    match: own.length > 0 ? "trip" : departure ? "line" : "none",
  };
}

export async function getVehicles(query: VehiclesQuery): Promise<VehiclesResponse> {
  const value = await fetchVehiclePositions();
  const departure = departureOf(query);
  const matched = departure ? matchTrip(departure, (await fetchTripUpdates()).trips) : null;
  return toResponse(value, query, null, matched);
}

export function subscribeToVehicles(
  query: VehiclesQuery,
  subscriber: (value: VehiclesResponse) => void,
) {
  const departure = departureOf(query);
  let latest: VehicleFeed | null = null;
  let latestError: string | null = null;
  let matched: string | null = null;

  const emit = () => subscriber(toResponse(latest, query, latestError, matched));

  const stopVehicles = feed.subscribe((value, error) => {
    latest = value;
    latestError = error;
    emit();
  });
  // The timetable feed is only polled while some map is asking "which one is mine".
  const stopTrips = departure
    ? tripUpdates.subscribe((value) => {
        const next = value ? matchTrip(departure, value.trips) : null;
        if (next !== matched) {
          matched = next;
          if (latest) emit();
        }
      })
    : () => {};

  return () => {
    stopVehicles();
    stopTrips();
  };
}

export function vehicleSubscriberCount() {
  return feed.subscriberCount;
}
