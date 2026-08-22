import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { TransportMode, VehiclePosition } from "@traveler/shared";
import { getBuffer } from "./http.ts";
import { env } from "../env.ts";
import { logger } from "../lib/log.ts";

const log = logger("gtfs-rt");

const FEED = "https://opendata.samtrafiken.se/gtfs-rt/sl/VehiclePositions.pb";

export type VehicleFeed = {
  vehicles: VehiclePosition[];
  available: boolean;
  reason: string | null;
  fetchedAt: string;
};

export function vehiclePositionsAvailable(): boolean {
  return Boolean(env.TRAFIKLAB_GTFS_RT_KEY);
}

/**
 * GTFS-Realtime route types, mapped onto our modes.
 * https://gtfs.org/documentation/schedule/reference/#routestxt
 */
function modeFromRouteType(routeType: number | null | undefined): TransportMode {
  switch (routeType) {
    case 0:
      return "TRAM";
    case 1:
      return "METRO";
    case 2:
      return "TRAIN";
    case 3:
      return "BUS";
    case 4:
      return "SHIP";
    case 6:
      return "UNKNOWN"; // aerial lift -- SL has none
    case 7:
      return "TRAIN"; // funicular
    default:
      return "UNKNOWN";
  }
}

/**
 * SL's route ids look like "9011001001700000" -- the same global id scheme as the
 * journey planner, where digits 8..11 are the line number. Decoding it locally avoids
 * pulling the 40 MB static GTFS routes.txt just to print "17" next to a dot on a map.
 * Anything that does not match the scheme falls back to the vehicle label, then to the
 * raw id, so a line is never silently blank.
 */
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

    vehicles.push({
      id: entity.id || v.vehicle?.id || `${lat},${lon}`,
      lat,
      lon,
      bearing: typeof position.bearing === "number" ? position.bearing : null,
      speed: typeof position.speed === "number" ? position.speed : null,
      mode: modeFromRouteType(
        // routeType is not in the standard VehicleDescriptor; SL omits it, so this is
        // effectively UNKNOWN until the static feed is joined in.
        null,
      ),
      line: lineFromRouteId(v.trip?.routeId, v.vehicle?.label),
      tripId: v.trip?.tripId ?? null,
      destination: null,
      timestamp: ts ? new Date(ts * 1000).toISOString() : null,
    });
  }

  log.debug(`decoded ${vehicles.length} vehicle positions`);
  return { vehicles, available: true, reason: null, fetchedAt };
}
