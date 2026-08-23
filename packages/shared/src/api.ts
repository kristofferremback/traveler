import { z } from "zod";
import {
  Departure,
  Deviation,
  Journey,
  Place,
  TransportMode,
  VehiclePosition,
} from "./domain.ts";

/** Query params are strings on the wire; these coerce and validate in one step. */
const numeric = z.coerce.number();
const int = z.coerce.number().int();
/** `.default` applies after the transform in zod 4, so the default is the output type. */
const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

export const PlaceSearchQuery = z.object({
  q: z.string().trim().min(1).max(120),
  /** Which kinds to include. Stops come from the local catalog, the rest go upstream. */
  kinds: z
    .string()
    .default("stop,address,poi")
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(z.array(z.enum(["stop", "address", "poi"])).min(1)),
  limit: int.min(1).max(50).default(12),
  /** Bias results toward here; also enables distance sorting for stops. */
  lat: numeric.optional(),
  lon: numeric.optional(),
});
export type PlaceSearchQuery = z.infer<typeof PlaceSearchQuery>;

export const NearbyQuery = z.object({
  lat: numeric,
  lon: numeric,
  radius: int.min(50).max(20000).default(1000),
  limit: int.min(1).max(100).default(20),
  modes: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").filter(Boolean) : undefined))
    .pipe(z.array(TransportMode).optional()),
});
export type NearbyQuery = z.infer<typeof NearbyQuery>;

export const PlaceSearchResponse = z.object({ places: z.array(Place) });
export type PlaceSearchResponse = z.infer<typeof PlaceSearchResponse>;

export const DeparturesQuery = z.object({
  /**
   * Minutes ahead. SL defaults to 60; we ask explicitly so the board is predictable.
   * The floor of 5 is SL's, enforced here so a bad value fails with our message rather
   * than surfacing as an opaque upstream 400.
   */
  forecast: int.min(5).max(1440).default(60),
  modes: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").filter(Boolean) : undefined))
    .pipe(z.array(TransportMode).optional()),
  line: z.string().optional(),
  direction: int.optional(),
});
export type DeparturesQuery = z.infer<typeof DeparturesQuery>;

export const DeparturesResponse = z.object({
  siteId: z.number().int(),
  /**
   * The same stop in the journey planner's id space. Carried alongside `siteId` because
   * the two are not interchangeable: departures are addressed by `siteId`, trips by
   * `siteGid`, and passing one where the other belongs returns an empty result rather
   * than an error.
   */
  siteGid: z.string().nullable(),
  siteName: z.string().nullable(),
  fetchedAt: z.string(),
  departures: z.array(Departure),
  deviations: z.array(Deviation),
});
export type DeparturesResponse = z.infer<typeof DeparturesResponse>;

export const JourneyQuery = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  via: z.string().optional(),
  /** ISO instant. Absent means "now". */
  when: z.string().optional(),
  arriveBy: bool.default(false),
  results: int.min(1).max(3).default(3),
  maxChanges: int.min(0).max(9).default(9),
  prefer: z.enum(["time", "interchanges", "walking"]).default("time"),
  modes: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").filter(Boolean) : undefined))
    .pipe(z.array(TransportMode).optional()),
  language: z.enum(["sv", "en"]).default("sv"),
});
export type JourneyQuery = z.infer<typeof JourneyQuery>;

export const JourneyResponse = z.object({
  journeys: z.array(Journey),
  from: Place.nullable(),
  to: Place.nullable(),
  fetchedAt: z.string(),
  notices: z.array(z.string()).default([]),
});
export type JourneyResponse = z.infer<typeof JourneyResponse>;

export const DeviationsQuery = z.object({
  site: z.string().optional(),
  line: z.string().optional(),
  modes: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").filter(Boolean) : undefined))
    .pipe(z.array(TransportMode).optional()),
  future: bool.default(false),
  minSeverity: z.enum(["info", "minor", "major", "severe"]).default("info"),
});
export type DeviationsQuery = z.infer<typeof DeviationsQuery>;

export const DeviationsResponse = z.object({
  deviations: z.array(Deviation),
  fetchedAt: z.string(),
});
export type DeviationsResponse = z.infer<typeof DeviationsResponse>;

export const VehiclesQuery = z.object({
  /** minLon,minLat,maxLon,maxLat -- keeps the payload to what the map can show. */
  bbox: z
    .string()
    .transform((s) => s.split(",").map(Number))
    .pipe(z.array(z.number()).length(4)),
  modes: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").filter(Boolean) : undefined))
    .pipe(z.array(TransportMode).optional()),
  line: z.string().optional(),
});
export type VehiclesQuery = z.infer<typeof VehiclesQuery>;

export const VehiclesResponse = z.object({
  vehicles: z.array(VehiclePosition),
  fetchedAt: z.string(),
  /** False when TRAFIKLAB_GTFS_RT_KEY is unset -- the UI says so instead of showing an empty map. */
  available: z.boolean(),
  reason: z.string().nullable().default(null),
});
export type VehiclesResponse = z.infer<typeof VehiclesResponse>;

export const CatalogStatus = z.object({
  sites: z.number().int(),
  stopPoints: z.number().int(),
  lines: z.number().int(),
  lastSyncAt: z.string().nullable(),
  lastSyncStatus: z.enum(["ok", "failed", "never"]),
  lastSyncError: z.string().nullable(),
  lastChange: z
    .object({ added: z.number(), updated: z.number(), removed: z.number() })
    .nullable(),
});
export type CatalogStatus = z.infer<typeof CatalogStatus>;

export const HealthResponse = z.object({
  ok: z.boolean(),
  version: z.string(),
  uptimeSeconds: z.number(),
  catalog: CatalogStatus,
  realtime: z.object({ vehiclePositions: z.boolean(), subscribers: z.number() }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// --- Account ----------------------------------------------------------------

/** Body of POST /api/invites. The name is only used for the account it may create. */
export const InviteRequest = z.object({
  email: z.string().trim().email().max(254),
  name: z.string().trim().max(120).optional(),
});
export type InviteRequest = z.infer<typeof InviteRequest>;

export const InviteResponse = z.object({
  email: z.string(),
  /** The whole invite: a one-time link, not emailed anywhere. */
  url: z.string(),
  expiresAt: z.string(),
});
export type InviteResponse = z.infer<typeof InviteResponse>;

export const MeResponse = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  passkeys: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      createdAt: z.string().nullable(),
    }),
  ),
  apiKeys: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      /** The first characters of the key, the only part stored in the clear. */
      start: z.string().nullable(),
      createdAt: z.string().nullable(),
      lastRequest: z.string().nullable(),
      expiresAt: z.string().nullable(),
    }),
  ),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/** Discriminated union of everything the SSE endpoints emit. */
export type StreamEvent =
  | { type: "departures"; data: DeparturesResponse }
  | { type: "vehicles"; data: VehiclesResponse }
  | { type: "deviations"; data: DeviationsResponse }
  | { type: "error"; data: { code: string; message: string } };
