import { Hono } from "hono";
import { NearbyQuery, PlaceSearchQuery } from "@traveler/shared";
import { locateCoordinate, resolvePlace, searchNearby, searchPlaces } from "../services/places.ts";
import { AppError } from "../lib/errors.ts";
import { parseQuery } from "./validate.ts";

export const places = new Hono();

places.get("/search", async (c) => {
  const query = parseQuery(PlaceSearchQuery, c);
  return c.json({ places: await searchPlaces(query) });
});

places.get("/nearby", (c) => {
  const query = parseQuery(NearbyQuery, c);
  return c.json({ places: searchNearby(query) });
});

/** Place ids contain colons and slashes, so they travel as a query parameter. */
places.get("/resolve", async (c) => {
  const id = c.req.query("id");
  if (!id) throw new AppError("missing_id", "Pass the place id as ?id=", 400);
  const place = await resolvePlace(id);
  if (!place) throw new AppError("not_found", `No place matches ${id}`, 404);
  return c.json({ place });
});

places.get("/locate", async (c) => {
  const lat = Number(c.req.query("lat"));
  const lon = Number(c.req.query("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new AppError("invalid_coordinate", "Pass ?lat= and ?lon=", 400);
  }
  return c.json({ place: await locateCoordinate(lat, lon), nearby: searchNearby({ lat, lon, radius: 800, limit: 8, modes: undefined }) });
});
