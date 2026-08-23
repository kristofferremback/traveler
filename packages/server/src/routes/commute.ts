import { Hono } from "hono";
import { CommuteQuery, NeighbourhoodQuery } from "@traveler/shared";
import { planCommute } from "../services/commute.ts";
import { getNeighbourhood } from "../services/neighbourhood.ts";
import { getSettings, mergeSettings } from "../services/savedPlaces.ts";
import { parseQuery } from "./validate.ts";

export const commute = new Hono();

/**
 * Door-to-door options between two places. `from`/`to` are place ids as everywhere
 * else, "lat,lon", or "place:<id>" for one of the caller's saved places. The walking
 * settings come from the account; a query parameter overrides one for this request.
 */
commute.get("/commute", async (c) => {
  const query = parseQuery(CommuteQuery, c);
  return c.json(await planCommute(query, c.get("user").id));
});

/** The stops you can walk to from a coordinate, at your speed, with the street facts. */
commute.get("/neighbourhood", async (c) => {
  const query = parseQuery(NeighbourhoodQuery, c);
  const { lat, lon, isochrones, ...overrides } = query;
  // The same rule as saved places and commutes: the account's settings, unless the
  // request says otherwise. A coordinate read that ignored them would show a different
  // neighbourhood from the one the place page shows for the same spot.
  const settings = mergeSettings(getSettings(c.get("user").id), overrides);
  return c.json(await getNeighbourhood(lat, lon, settings, { isochrones }));
});
