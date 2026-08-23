import { Hono } from "hono";
import {
  DeparturesQuery,
  DeviationsQuery,
  JourneyQuery,
  type PlaceResponse,
  type StreamError,
  VehiclesQuery,
} from "@traveler/shared";
import { getDepartures, subscribeToDepartures } from "../services/departures.ts";
import { getDeviations, subscribeToDeviations } from "../services/deviations.ts";
import { getVehicles, subscribeToVehicles } from "../services/vehicles.ts";
import { planJourney } from "../services/journeys.ts";
import { ERROR_EVENT, sseStream } from "../realtime/sse.ts";
import { parseIntParam, parseQuery } from "./validate.ts";
import { getSite, rowToPlace } from "../db/catalog.ts";
import { AppError } from "../lib/errors.ts";

export const transit = new Hono();

/** The `stream-error` payload: an upstream failure reported on an otherwise open stream. */
function upstream(message: string): StreamError {
  return { code: "upstream_error", message };
}

// --- Stops -------------------------------------------------------------------

/**
 * One stop, from the local catalog.
 *
 * Answered without touching SL, so a stop page renders its name, modes and journey
 * planner id immediately and still works when SL is unreachable. The alternative --
 * reading the name off a departures call -- ties the page header to an upstream request
 * that can legitimately return nothing at 03:00.
 */
transit.get("/sites/:siteId", (c) => {
  const siteId = parseIntParam(c.req.param("siteId"), "siteId");
  const site = getSite(siteId);
  if (!site) throw new AppError("not_found", `No stop with id ${siteId}`, 404);
  const body: PlaceResponse = { place: rowToPlace(site) };
  return c.json(body);
});

// --- Departures -------------------------------------------------------------

transit.get("/sites/:siteId/departures", async (c) => {
  const siteId = parseIntParam(c.req.param("siteId"), "siteId");
  const query = parseQuery(DeparturesQuery, c);
  return c.json(await getDepartures(siteId, query));
});

transit.get("/sites/:siteId/departures/stream", (c) => {
  const siteId = parseIntParam(c.req.param("siteId"), "siteId");
  const query = parseQuery(DeparturesQuery, c);

  return sseStream(c, `departures:${siteId}`, (push) =>
    subscribeToDepartures(siteId, query, (value, error) => {
      if (value) push("departures", value);
      if (error) push(ERROR_EVENT, upstream(error));
    }),
  );
});

// --- Journeys ---------------------------------------------------------------

transit.get("/journeys", async (c) => {
  const query = parseQuery(JourneyQuery, c);
  return c.json(await planJourney(query));
});

// --- Deviations -------------------------------------------------------------

transit.get("/deviations", async (c) => {
  const query = parseQuery(DeviationsQuery, c);
  return c.json(await getDeviations(query));
});

transit.get("/deviations/stream", (c) => {
  const query = parseQuery(DeviationsQuery, c);
  return sseStream(c, "deviations", (push) =>
    subscribeToDeviations(query, (value, error) => {
      if (value) push("deviations", value);
      if (error) push(ERROR_EVENT, upstream(error));
    }),
  );
});

// --- Vehicle positions ------------------------------------------------------

transit.get("/vehicles", async (c) => {
  const query = parseQuery(VehiclesQuery, c);
  return c.json(await getVehicles(query));
});

transit.get("/vehicles/stream", (c) => {
  const query = parseQuery(VehiclesQuery, c);
  return sseStream(c, "vehicles", (push) =>
    subscribeToVehicles(query, (value) => push("vehicles", value)),
  );
});
