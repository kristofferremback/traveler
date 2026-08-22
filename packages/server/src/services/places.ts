import type { Place, PlaceSearchQuery, NearbyQuery } from "@traveler/shared";
import { cached } from "../db/cache.ts";
import { getSiteByGid, nearbyStops, rowToPlace, searchStops, siteNearCoordinate } from "../db/catalog.ts";
import { reverseGeocode, stopFinder } from "../sl/journeyplanner.ts";
import { logger } from "../lib/log.ts";
import { describe } from "../lib/errors.ts";
import { haversineMetres } from "../lib/geo.ts";

const log = logger("places");

/**
 * Attach the local site id to a place the journey planner returned.
 *
 * The two systems share one number: the planner's global location id is the catalog's
 * `gid`. Without this a search result cannot open a departures board, because the
 * departures endpoint addresses stops by the *other* id.
 */
export function enrichWithSiteId(place: Place): Place {
  if (place.kind !== "stop" || place.siteId !== null) return place;
  const site = getSiteByGid(place.id);
  if (!site) return place;
  return {
    ...place,
    siteId: site.id,
    // The catalog's own name is cleaner than EFA's "Stockholm, Slussen" rendering.
    name: site.name,
    locality: place.locality ?? site.note,
    modes: place.modes.length > 0 ? place.modes : rowToPlace(site).modes,
  };
}

/** Same idea for a bare coordinate: journey legs carry platform positions, not site ids. */
export function siteIdNear(lat: number | null, lon: number | null): number | null {
  if (lat === null || lon === null) return null;
  return siteNearCoordinate(lat, lon)?.id ?? null;
}

/**
 * Stops are answered from the local catalog; addresses and POIs have no bulk export
 * and must be asked for live.
 *
 * The split is not an optimisation, it is the only shape available. It does mean stop
 * search keeps working when SL's journey planner is down, and that as-you-type search
 * costs one SQLite query rather than one upstream request per keystroke.
 */
export async function searchPlaces(query: PlaceSearchQuery): Promise<Place[]> {
  const kinds = new Set(query.kinds);
  const origin =
    query.lat !== undefined && query.lon !== undefined
      ? { lat: query.lat, lon: query.lon }
      : undefined;

  const local = kinds.has("stop") ? searchStops(query.q, query.limit, origin) : [];

  const needsUpstream = kinds.has("address") || kinds.has("poi");
  let upstream: Place[] = [];
  if (needsUpstream) {
    try {
      upstream = await cached(
        `stop-finder:${query.q.toLowerCase()}:${[...kinds].sort().join(",")}`,
        // Addresses and POIs change on the order of months. A minute of staleness is
        // invisible to a traveller and removes most repeat traffic while typing.
        60,
        () =>
          stopFinder(query.q, {
            stops: kinds.has("stop"),
            addresses: kinds.has("address"),
            pois: kinds.has("poi"),
          }),
      );
    } catch (err) {
      // Degrade to local results rather than failing the whole search. A stop list is
      // most of what anyone wants, and an empty box would hide it.
      log.warn(`stop-finder unavailable, serving local stops only: ${describe(err)}`);
    }
  }

  const merged: Place[] = [];
  const seen = new Set<string>();

  for (const place of local) {
    seen.add(place.id);
    merged.push(place);
  }

  for (const raw of upstream) {
    const place = enrichWithSiteId(raw);
    if (seen.has(place.id)) continue; // The catalog copy already won.
    seen.add(place.id);
    merged.push({
      ...place,
      distanceMetres: origin
        ? Math.round(haversineMetres(origin.lat, origin.lon, place.lat, place.lon))
        : null,
    });
  }

  // Stops before places, because on a transit app a stop is almost always the intent.
  const rank = { stop: 0, poi: 1, address: 2 } as const;
  merged.sort((a, b) => rank[a.kind] - rank[b.kind]);

  return merged.slice(0, query.limit);
}

export function searchNearby(query: NearbyQuery): Place[] {
  return nearbyStops(query.lat, query.lon, query.radius, query.limit, query.modes);
}

/** "Where am I" -- a street address for a GPS fix, so the trip form can be pre-filled. */
export async function locateCoordinate(lat: number, lon: number): Promise<Place | null> {
  try {
    const place = await cached(
      `reverse:${lat.toFixed(4)}:${lon.toFixed(4)}`,
      300,
      () => reverseGeocode(lat, lon),
    );
    return place ? enrichWithSiteId(place) : null;
  } catch (err) {
    log.warn(`reverse geocode failed: ${describe(err)}`);
    return null;
  }
}

/**
 * Resolve an opaque place id back into a full place, for deep links and saved trips.
 *
 * Catalog stops resolve locally and instantly. Address and POI ids are EFA strings
 * that the stop finder accepts back verbatim, so they are looked up rather than
 * decoded -- their id embeds a SWEREF 99 grid reference, not WGS84, and inventing a
 * position from it would put places somewhere plausible and wrong.
 */
export async function resolvePlace(id: string): Promise<Place | null> {
  const site = getSiteByGid(id);
  if (site) return rowToPlace(site);

  try {
    const matches = await cached(`resolve:${id}`, 3600, () => stopFinder(id, {}));
    const match = matches[0];
    return match ? enrichWithSiteId(match) : null;
  } catch (err) {
    log.warn(`could not resolve place ${id}: ${describe(err)}`);
    return null;
  }
}
