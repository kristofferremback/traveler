import type { Journey, JourneyQuery, JourneyResponse } from "@traveler/shared";
import { trips } from "../sl/journeyplanner.ts";
import { resolvePlace } from "./places.ts";
import { siteNearCoordinate, stopPointsNear } from "../db/catalog.ts";
import { AppError } from "../lib/errors.ts";

/**
 * Give every stop in a journey a site id where one exists, so each row in the result
 * can open its own departures board. The journey planner reports platform coordinates;
 * the catalog turns those back into stops.
 */
/** A platform coordinate is nearer some other site's centroid more often than you would think. */
const PLATFORM_TOLERANCE_M = 80;

export function attachSiteIds(journey: Journey): Journey {
  // The planner reports the platform. The nearest stop *point* is that platform, and
  // its site is the right one; the nearest site centroid is not, where two sites sit
  // close: the Stadsgården platform at Slussen is nearer Glasbruksgatan's centroid than
  // Slussen's own. A trip planned "from here" must be from here.
  const site = (lat: number | null, lon: number | null) => {
    if (lat === null || lon === null) return { siteId: null, siteGid: null };
    const point = stopPointsNear(lat, lon, PLATFORM_TOLERANCE_M)[0];
    if (point) return { siteId: point.site_id, siteGid: point.site_gid };
    const row = siteNearCoordinate(lat, lon);
    return { siteId: row?.id ?? null, siteGid: row?.gid ?? null };
  };
  return {
    ...journey,
    legs: journey.legs.map((leg) => ({
      ...leg,
      origin: { ...leg.origin, ...site(leg.origin.lat, leg.origin.lon) },
      destination: { ...leg.destination, ...site(leg.destination.lat, leg.destination.lon) },
      intermediateStops: leg.intermediateStops.map((stop) => ({
        ...stop,
        siteId: site(stop.lat, stop.lon).siteId,
      })),
    })),
  };
}

export async function planJourney(query: JourneyQuery): Promise<JourneyResponse> {
  let when: Date | undefined;
  if (query.when) {
    const parsed = new Date(query.when);
    if (Number.isNaN(parsed.getTime())) {
      throw new AppError("invalid_time", `Could not read "${query.when}" as a time.`, 400);
    }
    when = parsed;
  }

  const result = await trips({
    from: { id: query.from },
    to: { id: query.to },
    viaId: query.via,
    when,
    arriveBy: query.arriveBy,
    results: query.results,
    maxChanges: query.maxChanges,
    prefer: query.prefer,
    modes: query.modes,
    language: query.language,
  });

  // Endpoint labels are resolved alongside the trip so a shared link renders with real
  // names rather than the opaque ids it carries.
  const [from, to] = await Promise.all([
    resolvePlace(query.from),
    resolvePlace(query.to),
  ]);

  return {
    journeys: result.journeys.map(attachSiteIds),
    from,
    to,
    fetchedAt: new Date().toISOString(),
    notices: result.notices,
  };
}
