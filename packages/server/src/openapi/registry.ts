import { z } from "zod";
import {
  CommuteQuery,
  CommuteResponse,
  DeparturesQuery,
  DeparturesResponse,
  DeviationsQuery,
  DeviationsResponse,
  HealthResponse,
  InviteRequest,
  InviteResponse,
  InvitesResponse,
  JourneyQuery,
  JourneyResponse,
  LocateResponse,
  MeResponse,
  NearbyQuery,
  Neighbourhood,
  NeighbourhoodQuery,
  PlaceLocateQuery,
  PlaceNeighbourhoodQuery,
  PlaceResolveQuery,
  PlaceResponse,
  PlaceSearchQuery,
  PlaceSearchResponse,
  ReadyResponse,
  SavedPlaceInput,
  SavedPlacePatch,
  SavedPlaceResponse,
  SavedPlacesResponse,
  UserSettingsPatch,
  UserSettingsResponse,
  VehiclesQuery,
  VehiclesResponse,
} from "@traveler/shared";

/**
 * Every route this API answers, described once.
 *
 * The schemas are the ones the routes themselves validate and build with, imported from
 * @traveler/shared rather than restated here: a document written in its own words drifts
 * from the server the first time a field is added. `__tests__/document.test.ts` closes
 * the other half of the gap by failing when a route exists that this list does not name.
 *
 * The auth endpoints under /api/auth are deliberately absent; they are Better Auth's own
 * and are described in prose in the document's `info.description`.
 */

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface RouteDoc {
  method: HttpMethod;
  /** OpenAPI form, with `{name}` placeholders where Hono writes `:name`. */
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  /** A zod object; each of its top-level keys becomes one query parameter. */
  query?: z.ZodType;
  params?: Record<string, z.ZodType>;
  body?: z.ZodType;
  /** The success body. Absent only where there is none, i.e. a 204. */
  response?: z.ZodType;
  /** Success status. Defaults to 200. */
  status?: number;
  /** Answers without a session or an API key. */
  public?: boolean;
  /** Answers `text/event-stream` rather than JSON; `response` is the event payload. */
  stream?: boolean;
  /** The SSE event name carrying `response`. Stream routes only. */
  event?: string;
  /** The route can answer 404 for a well-formed request. */
  notFound?: boolean;
  /**
   * Outcomes beyond the usual 400/401/404/429 set. `response` defaults to `ApiError`.
   */
  extra?: Array<{ status: number; description: string; response?: z.ZodType }>;
}

/** A positive integer path segment, the way `parseIntParam` reads one. */
const IdParam = z.coerce.number().int().positive();

/**
 * A MapLibre GL style document.
 *
 * Deliberately loose: with PMTILES_PATH set this is our own style, and without it the
 * body is OpenFreeMap's, passed through untouched. Describing it in more detail than the
 * three keys every style has would be describing someone else's document.
 */
const MapStyle = z
  .looseObject({
    version: z.number(),
    sources: z.record(z.string(), z.unknown()),
    layers: z.array(z.unknown()),
  })
  .describe("A MapLibre GL style document.");

const MapStyleQuery = z.object({
  theme: z
    .enum(["dark", "light"])
    .default("dark")
    .describe("Which flavour of the basemap to return."),
});

/** This document. Loose, because it is an OpenAPI document and OpenAPI describes itself. */
const OpenApiDocumentSchema = z
  .looseObject({
    openapi: z.string(),
    info: z.looseObject({ title: z.string(), version: z.string() }),
    paths: z.record(z.string(), z.unknown()),
  })
  .describe("An OpenAPI 3.1 document.");

export const ROUTES: RouteDoc[] = [
  // --- Meta -----------------------------------------------------------------
  {
    method: "get",
    path: "/api/health",
    summary: "Liveness and catalog status",
    description:
      "Answers 200 from the moment the process is up, even with an empty catalog, so a platform health check cannot kill a container during its first sync. Use /api/ready to find out whether the catalog can actually answer.",
    tags: ["Meta"],
    response: HealthResponse,
    public: true,
  },
  {
    method: "get",
    path: "/api/ready",
    summary: "Readiness",
    description:
      "200 once the stops are loaded and the search index is built, 503 until then with `reasons` naming what is missing. Anything that needs the catalog should wait on this rather than on /api/health.",
    tags: ["Meta"],
    response: ReadyResponse,
    public: true,
    extra: [
      {
        status: 503,
        description: "The catalog cannot answer yet; `reasons` names what is missing.",
        response: ReadyResponse,
      },
    ],
  },
  {
    method: "get",
    path: "/api/openapi.json",
    summary: "This document",
    description: "The API contract, not data, so it needs no key.",
    tags: ["Meta"],
    response: OpenApiDocumentSchema,
    public: true,
  },

  // --- Places ---------------------------------------------------------------
  {
    method: "get",
    path: "/api/places/search",
    summary: "Search stops, addresses and points of interest",
    description:
      "Stops come from the local catalog with diacritics folded, so `sodermalm` finds Södermalm; addresses and points of interest are asked of SL's journey planner. `lat`/`lon` bias the results and sort stops by distance.",
    tags: ["Places"],
    query: PlaceSearchQuery,
    response: PlaceSearchResponse,
  },
  {
    method: "get",
    path: "/api/places/nearby",
    summary: "Stops near a coordinate",
    tags: ["Places"],
    query: NearbyQuery,
    response: PlaceSearchResponse,
  },
  {
    method: "get",
    path: "/api/places/resolve",
    summary: "Look up one place by id",
    description:
      "Place ids are opaque and must round-trip untouched; they contain colons and slashes, so this takes one as a query parameter rather than a path segment.",
    tags: ["Places"],
    query: PlaceResolveQuery,
    response: PlaceResponse,
    notFound: true,
  },
  {
    method: "get",
    path: "/api/places/locate",
    summary: "What is at a coordinate",
    description: "The address a GPS fix reverse-geocodes to, plus the stops around it.",
    tags: ["Places"],
    query: PlaceLocateQuery,
    response: LocateResponse,
  },

  // --- Stops and departures -------------------------------------------------
  {
    method: "get",
    path: "/api/sites/{siteId}",
    summary: "One stop from the local catalog",
    description:
      "Answered without touching SL, so it still works when SL is unreachable. `siteId` is SL's numeric site id, the one departures are addressed by; `place.id` in the response is the gid, the one trips are addressed by.",
    tags: ["Stops"],
    params: { siteId: IdParam },
    response: PlaceResponse,
    notFound: true,
  },
  {
    method: "get",
    path: "/api/sites/{siteId}/departures",
    summary: "A departure board",
    tags: ["Stops"],
    params: { siteId: IdParam },
    query: DeparturesQuery,
    response: DeparturesResponse,
  },
  {
    method: "get",
    path: "/api/sites/{siteId}/departures/stream",
    summary: "A departure board, live",
    description:
      "The same board pushed as it changes. One upstream poll is shared across every subscriber to a stop, so watching costs no more than reading.",
    tags: ["Stops"],
    params: { siteId: IdParam },
    query: DeparturesQuery,
    response: DeparturesResponse,
    stream: true,
    event: "departures",
  },

  // --- Journeys -------------------------------------------------------------
  {
    method: "get",
    path: "/api/journeys",
    summary: "Plan a trip between two places",
    description:
      "`from`/`to` are place ids as returned by /api/places/search. For door-to-door options that include the walk at each end, use /api/commute instead.",
    tags: ["Journeys"],
    query: JourneyQuery,
    response: JourneyResponse,
  },

  // --- Deviations -----------------------------------------------------------
  {
    method: "get",
    path: "/api/deviations",
    summary: "Disruptions, filterable by stop, line and mode",
    tags: ["Deviations"],
    query: DeviationsQuery,
    response: DeviationsResponse,
  },
  {
    method: "get",
    path: "/api/deviations/stream",
    summary: "Disruptions, live",
    tags: ["Deviations"],
    query: DeviationsQuery,
    response: DeviationsResponse,
    stream: true,
    event: "deviations",
  },

  // --- Vehicles -------------------------------------------------------------
  {
    method: "get",
    path: "/api/vehicles",
    summary: "Vehicle positions inside a bounding box",
    description:
      "Needs TRAFIKLAB_GTFS_RT_KEY on the server. Without it the response is `available: false` with a `reason` rather than an empty list, so a client can say why the map is bare.",
    tags: ["Vehicles"],
    query: VehiclesQuery,
    response: VehiclesResponse,
  },
  {
    method: "get",
    path: "/api/vehicles/stream",
    summary: "Vehicle positions, live",
    tags: ["Vehicles"],
    query: VehiclesQuery,
    response: VehiclesResponse,
    stream: true,
    event: "vehicles",
  },

  // --- Commute --------------------------------------------------------------
  {
    method: "get",
    path: "/api/commute",
    summary: "Door-to-door options between two places",
    description:
      "The one an agent usually wants. `from`/`to` take a place id, a bare `lat,lon`, or `place:<id>` for one of your own saved places. Each option carries the walk at both ends, when to leave the door, and whether the departure is still catchable. The five walking settings come from your account; passing one as a query parameter overrides it for this request only.",
    tags: ["Commute"],
    query: CommuteQuery,
    response: CommuteResponse,
  },
  {
    method: "get",
    path: "/api/neighbourhood",
    summary: "What you can walk to from a coordinate",
    description:
      "The stop points reachable on foot, each with the routed distance, the climb in both directions, and the seconds it takes at your walking speed. Optionally the isochrone rings to draw.",
    tags: ["Commute"],
    query: NeighbourhoodQuery,
    response: Neighbourhood,
  },

  // --- Saved places ---------------------------------------------------------
  {
    method: "get",
    path: "/api/places",
    summary: "Your saved places",
    tags: ["Saved places"],
    response: SavedPlacesResponse,
  },
  {
    method: "post",
    path: "/api/places",
    summary: "Save a place",
    description:
      "Either `placeId`, resolved server-side, or a bare `lat`+`lon`. Never both: two sources for the same three fields is two ways for them to disagree.",
    tags: ["Saved places"],
    body: SavedPlaceInput,
    response: SavedPlaceResponse,
    status: 201,
  },
  {
    method: "get",
    path: "/api/places/{id}",
    summary: "One saved place",
    tags: ["Saved places"],
    params: { id: IdParam },
    response: SavedPlaceResponse,
    notFound: true,
  },
  {
    method: "patch",
    path: "/api/places/{id}",
    summary: "Rename or reorder a saved place",
    tags: ["Saved places"],
    params: { id: IdParam },
    body: SavedPlacePatch,
    response: SavedPlaceResponse,
    notFound: true,
  },
  {
    method: "delete",
    path: "/api/places/{id}",
    summary: "Forget a saved place",
    tags: ["Saved places"],
    params: { id: IdParam },
    status: 204,
    notFound: true,
  },
  {
    method: "get",
    path: "/api/places/{id}/neighbourhood",
    summary: "What you can walk to from a saved place",
    tags: ["Saved places"],
    params: { id: IdParam },
    query: PlaceNeighbourhoodQuery,
    response: Neighbourhood,
    notFound: true,
  },

  // --- Account --------------------------------------------------------------
  {
    method: "get",
    path: "/api/settings",
    summary: "Your walking settings",
    description: "The five values every commute and neighbourhood read uses by default.",
    tags: ["Account"],
    response: UserSettingsResponse,
  },
  {
    method: "put",
    path: "/api/settings",
    summary: "Change your walking settings",
    description: "A patch: fields you leave out keep the value they had.",
    tags: ["Account"],
    body: UserSettingsPatch,
    response: UserSettingsResponse,
  },
  {
    method: "get",
    path: "/api/me",
    summary: "Who you are, with your passkeys and API keys",
    tags: ["Account"],
    response: MeResponse,
  },
  {
    method: "post",
    path: "/api/invites",
    summary: "Mint an invite link",
    description:
      "The link comes back in the response and goes nowhere else -- nothing is emailed, so passing it on is the inviter's job.",
    tags: ["Account"],
    body: InviteRequest,
    response: InviteResponse,
    status: 201,
  },
  {
    method: "get",
    path: "/api/invites",
    summary: "Your invites that can still be followed",
    tags: ["Account"],
    response: InvitesResponse,
  },

  // --- Map ------------------------------------------------------------------
  {
    method: "get",
    path: "/api/map/style.json",
    summary: "The basemap style",
    description:
      "Our own quiet vector style when a .pmtiles archive is configured, otherwise OpenFreeMap's, cached and passed through. 502 when neither is available: a map drawn on a basemap nobody chose is worse than one that says its ground is missing.",
    tags: ["Map"],
    query: MapStyleQuery,
    response: MapStyle,
    extra: [
      { status: 502, description: "No basemap could be fetched and none is self-hosted." },
    ],
  },
];
