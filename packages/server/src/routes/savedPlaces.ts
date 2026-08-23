import { Hono } from "hono";
import {
  PlaceNeighbourhoodQuery,
  SavedPlaceInput,
  SavedPlacePatch,
  UserSettingsPatch,
} from "@traveler/shared";
import {
  createPlace,
  deletePlace,
  getPlace,
  getSettings,
  listPlaces,
  mergeSettings,
  putSettings,
  updatePlace,
} from "../services/savedPlaces.ts";
import { getNeighbourhood } from "../services/neighbourhood.ts";
import { AppError } from "../lib/errors.ts";
import { parseBody, parseIntParam, parseQuery } from "./validate.ts";

export const savedPlaces = new Hono();

/**
 * The caller's own places and settings. Behind `apiGate`, so `c.get("user")` is always
 * there and the id it carries is the only owner any statement below will accept.
 *
 * Mounted after the place *search* routes, so `/api/places/search` keeps meaning search
 * rather than "the place with id search".
 */

function notFound(id: number): AppError {
  return new AppError("not_found", `Ingen sparad plats med id ${id}.`, 404);
}

savedPlaces.get("/places", (c) => c.json({ places: listPlaces(c.get("user").id) }));

savedPlaces.post("/places", async (c) => {
  const input = await parseBody(SavedPlaceInput, c);
  return c.json({ place: await createPlace(c.get("user").id, input) }, 201);
});

savedPlaces.get("/places/:id", (c) => {
  const id = parseIntParam(c.req.param("id"), "id");
  const place = getPlace(c.get("user").id, id);
  if (!place) throw notFound(id);
  return c.json({ place });
});

savedPlaces.patch("/places/:id", async (c) => {
  const id = parseIntParam(c.req.param("id"), "id");
  const patch = await parseBody(SavedPlacePatch, c);
  const place = updatePlace(c.get("user").id, id, patch);
  if (!place) throw notFound(id);
  return c.json({ place });
});

savedPlaces.delete("/places/:id", (c) => {
  const id = parseIntParam(c.req.param("id"), "id");
  if (!deletePlace(c.get("user").id, id)) throw notFound(id);
  return c.body(null, 204);
});

/**
 * What you can walk to from a saved place.
 *
 * The stored settings decide it; `speedKmh` and `maxWalkMinutes` may be overridden per
 * request so a map can show a wider circle without changing the account.
 */
savedPlaces.get("/places/:id/neighbourhood", async (c) => {
  const id = parseIntParam(c.req.param("id"), "id");
  const userId = c.get("user").id;
  const place = getPlace(userId, id);
  if (!place) throw notFound(id);

  const { isochrones, ...overrides } = parseQuery(PlaceNeighbourhoodQuery, c);
  const settings = mergeSettings(getSettings(userId), overrides);
  return c.json(await getNeighbourhood(place.lat, place.lon, settings, { isochrones }));
});

savedPlaces.get("/settings", (c) => c.json({ settings: getSettings(c.get("user").id) }));

savedPlaces.put("/settings", async (c) => {
  const patch = await parseBody(UserSettingsPatch, c);
  return c.json({ settings: putSettings(c.get("user").id, patch) });
});
