import type { Journey, JourneyQuery, JourneyResponse } from "@traveler/shared";
import { trips } from "../sl/journeyplanner.ts";
import { resolvePlace, siteIdNear } from "./places.ts";
import { AppError } from "../lib/errors.ts";

/**
 * Give every stop in a journey a site id where one exists, so each row in the result
 * can open its own departures board. The journey planner reports platform coordinates;
 * the catalog turns those back into stops.
 */
function attachSiteIds(journey: Journey): Journey {
  return {
    ...journey,
    legs: journey.legs.map((leg) => ({
      ...leg,
      origin: { ...leg.origin, siteId: siteIdNear(leg.origin.lat, leg.origin.lon) },
      destination: {
        ...leg.destination,
        siteId: siteIdNear(leg.destination.lat, leg.destination.lon),
      },
      intermediateStops: leg.intermediateStops.map((stop) => ({
        ...stop,
        siteId: siteIdNear(stop.lat, stop.lon),
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
    fromId: query.from,
    toId: query.to,
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
