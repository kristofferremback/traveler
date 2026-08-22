import type { VehiclePosition, VehiclesQuery, VehiclesResponse } from "@traveler/shared";
import { env } from "../env.ts";
import { bboxFromTuple, withinBBox } from "../lib/geo.ts";
import { PollingHub } from "../realtime/hub.ts";
import { fetchVehiclePositions, vehiclePositionsAvailable, type VehicleFeed } from "../sl/gtfsrt.ts";

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

function filter(vehicles: VehiclePosition[], query: VehiclesQuery): VehiclePosition[] {
  const box = bboxFromTuple(query.bbox);
  const wantedModes = query.modes?.length ? new Set(query.modes) : null;
  const line = query.line?.trim();

  return vehicles.filter((v) => {
    if (!withinBBox(v.lat, v.lon, box)) return false;
    if (line && v.line !== line) return false;
    // Mode is UNKNOWN until the static GTFS feed is joined in, so a mode filter would
    // currently hide everything. Applied only when the feed actually carries a mode.
    if (wantedModes && v.mode !== "UNKNOWN" && !wantedModes.has(v.mode)) return false;
    return true;
  });
}

function toResponse(value: VehicleFeed | null, query: VehiclesQuery, error: string | null): VehiclesResponse {
  if (!value) {
    return {
      vehicles: [],
      fetchedAt: new Date().toISOString(),
      available: vehiclePositionsAvailable(),
      reason: error ?? (vehiclePositionsAvailable() ? "Waiting for the first feed." : null),
    };
  }
  return {
    vehicles: filter(value.vehicles, query),
    fetchedAt: value.fetchedAt,
    available: value.available,
    // A stale-but-served feed still reports the error, so the UI can show both the
    // last known positions and the fact that they stopped updating.
    reason: error ?? value.reason,
  };
}

export async function getVehicles(query: VehiclesQuery): Promise<VehiclesResponse> {
  const value = await fetchVehiclePositions();
  return toResponse(value, query, null);
}

export function subscribeToVehicles(
  query: VehiclesQuery,
  subscriber: (value: VehiclesResponse) => void,
) {
  return feed.subscribe((value, error) => subscriber(toResponse(value, query, error)));
}

export function vehicleSubscriberCount() {
  return feed.subscriberCount;
}
