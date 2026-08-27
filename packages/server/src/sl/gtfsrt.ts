import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { VehiclePosition } from "@traveler/shared";
import { getBuffer } from "./http.ts";
import { env } from "../env.ts";
import { logger } from "../lib/log.ts";
import { tripInfo } from "../db/gtfs.ts";

const log = logger("gtfs-rt");

const FEED = "https://opendata.samtrafiken.se/gtfs-rt/sl/VehiclePositions.pb";
const TRIP_UPDATES = "https://opendata.samtrafiken.se/gtfs-rt/sl/TripUpdates.pb";

/** One running trip's timetable as SL currently predicts it. */
export type TripTimes = {
  tripId: string;
  /** SL's line gid, from the static join; null until the join knows the trip. */
  routeId: string | null;
  stops: { stopId: string; scheduledDeparture: number }[];
};

export type TripUpdateFeed = {
  trips: TripTimes[];
  available: boolean;
  fetchedAt: string;
};

/**
 * The TripUpdates feed, reduced to what identifies a departure: for every running trip,
 * its stops with the scheduled departure (SL sends the predicted time and the delay;
 * the scheduled one is their difference). Polled only while a map is asking which
 * vehicle is the traveller's.
 */
export async function fetchTripUpdates(): Promise<TripUpdateFeed> {
  const fetchedAt = new Date().toISOString();
  const key = env.TRAFIKLAB_GTFS_RT_KEY;
  if (!key) return { trips: [], available: false, fetchedAt };

  const bytes = await getBuffer(TRIP_UPDATES, {
    upstream: "trafiklab/trip-updates",
    query: { key },
    accept: "application/x-protobuf",
    timeoutMs: 10_000,
    retries: 1,
  });
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
  const trips: TripTimes[] = [];
  for (const entity of feed.entity ?? []) {
    const update = entity.tripUpdate;
    const tripId = update?.trip?.tripId;
    if (!update || !tripId) continue;
    const stops: TripTimes["stops"] = [];
    for (const stu of update.stopTimeUpdate ?? []) {
      const event = stu.departure ?? stu.arrival;
      const time = event?.time === null || event?.time === undefined ? null : Number(event.time);
      if (!stu.stopId || time === null) continue;
      stops.push({ stopId: stu.stopId, scheduledDeparture: (time - (event?.delay ?? 0)) * 1000 });
    }
    trips.push({ tripId, routeId: tripInfo(tripId)?.routeId ?? null, stops });
  }
  log.debug(`decoded ${trips.length} trip updates`);
  return { trips, available: true, fetchedAt };
}

export type VehicleFeed = {
  vehicles: VehiclePosition[];
  available: boolean;
  reason: string | null;
  fetchedAt: string;
};

export function vehiclePositionsAvailable(): boolean {
  return Boolean(env.TRAFIKLAB_GTFS_RT_KEY);
}

export function lineFromRouteId(
  routeId: string | null | undefined,
  label: string | null | undefined,
): string | null {
  const id = (routeId ?? "").trim();
  if (/^\d{16}$/.test(id)) {
    const designation = id.slice(7, 11).replace(/^0+/, "");
    if (designation) return designation;
  }
  const labelled = (label ?? "").trim();
  if (labelled) return labelled;
  return id || null;
}

export async function fetchVehiclePositions(): Promise<VehicleFeed> {
  const fetchedAt = new Date().toISOString();
  const key = env.TRAFIKLAB_GTFS_RT_KEY;

  if (!key) {
    return {
      vehicles: [],
      available: false,
      reason:
        "Live vehicle positions need a Trafiklab GTFS-Realtime key. Set TRAFIKLAB_GTFS_RT_KEY and restart.",
      fetchedAt,
    };
  }

  const bytes = await getBuffer(FEED, {
    upstream: "trafiklab/vehicle-positions",
    query: { key },
    accept: "application/x-protobuf",
    timeoutMs: 10_000,
    retries: 1,
  });

  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
  const vehicles: VehiclePosition[] = [];

  for (const entity of feed.entity ?? []) {
    const v = entity.vehicle;
    const position = v?.position;
    if (!v || !position) continue;
    const lat = position.latitude;
    const lon = position.longitude;
    if (typeof lat !== "number" || typeof lon !== "number") continue;

    // `timestamp` is a Long in protobuf; Number() handles both that and a plain number.
    const ts = v.timestamp === null || v.timestamp === undefined ? null : Number(v.timestamp);

    // SL's feed names a vehicle by trip id alone; the static GTFS tables turn that into
    // a line, a mode and a headsign. Without them (no key, first boot) the fallbacks
    // give UNKNOWN and whatever the route id can be read as.
    const tripId = v.trip?.tripId ?? null;
    const info = tripId ? tripInfo(tripId) : null;
    vehicles.push({
      id: entity.id || v.vehicle?.id || `${lat},${lon}`,
      lat,
      lon,
      bearing: typeof position.bearing === "number" ? position.bearing : null,
      speed: typeof position.speed === "number" ? position.speed : null,
      mode: info?.mode ?? "UNKNOWN",
      line: info?.line ?? lineFromRouteId(v.trip?.routeId, v.vehicle?.label),
      tripId,
      destination: info?.headsign ?? null,
      directionId: info?.directionId ?? null,
      timestamp: ts ? new Date(ts * 1000).toISOString() : null,
    });
  }

  log.debug(`decoded ${vehicles.length} vehicle positions`);
  return { vehicles, available: true, reason: null, fetchedAt };
}
