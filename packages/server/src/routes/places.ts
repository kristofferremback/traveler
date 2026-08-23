import { Hono } from "hono";
import {
  type LocateResponse,
  NearbyQuery,
  PlaceLocateQuery,
  PlaceResolveQuery,
  type PlaceResponse,
  type PlaceSearchResponse,
  PlaceSearchQuery,
} from "@traveler/shared";
import { locateCoordinate, resolvePlace, searchNearby, searchPlaces } from "../services/places.ts";
import { AppError } from "../lib/errors.ts";
import { parseQuery } from "./validate.ts";

export const places = new Hono();

places.get("/search", async (c) => {
  const query = parseQuery(PlaceSearchQuery, c);
  const body: PlaceSearchResponse = { places: await searchPlaces(query) };
  return c.json(body);
});

places.get("/nearby", (c) => {
  const query = parseQuery(NearbyQuery, c);
  const body: PlaceSearchResponse = { places: searchNearby(query) };
  return c.json(body);
});

/** Place ids contain colons and slashes, so they travel as a query parameter. */
places.get("/resolve", async (c) => {
  const { id } = parseQuery(PlaceResolveQuery, c);
  const place = await resolvePlace(id);
  if (!place) throw new AppError("not_found", `No place matches ${id}`, 404);
  const body: PlaceResponse = { place };
  return c.json(body);
});

places.get("/locate", async (c) => {
  const { lat, lon } = parseQuery(PlaceLocateQuery, c);
  const body: LocateResponse = {
    place: await locateCoordinate(lat, lon),
    nearby: searchNearby({ lat, lon, radius: 800, limit: 8, modes: undefined }),
  };
  return c.json(body);
});
