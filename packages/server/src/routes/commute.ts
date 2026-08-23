import { Hono } from "hono";
import { CommuteQuery, NeighbourhoodQuery } from "@traveler/shared";
import { planCommute } from "../services/commute.ts";
import { getNeighbourhood } from "../services/neighbourhood.ts";
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
  const { lat, lon, isochrones, ...settings } = query;
  return c.json(await getNeighbourhood(lat, lon, settings, { isochrones }));
});
