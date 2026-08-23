import { z } from "zod";

/**
 * SL exposes the same concepts through three unrelated APIs with three different
 * vocabularies. Everything below is Traveler's own vocabulary; the SL clients are
 * responsible for translating into it and nothing downstream of them should ever
 * see an EFA `productClass` or a naive SL timestamp.
 */

export const TransportMode = z.enum([
  "BUS",
  "METRO",
  "TRAM",
  "TRAIN",
  "SHIP",
  "FERRY",
  "TAXI",
  "WALK",
  "UNKNOWN",
]);
export type TransportMode = z.infer<typeof TransportMode>;

/** Every timestamp crossing the API boundary is an absolute instant, ISO 8601 with offset. */
export const Instant = z.iso.datetime({ offset: true });
export type Instant = string;

export const PlaceKind = z.enum(["stop", "address", "poi"]);
export type PlaceKind = z.infer<typeof PlaceKind>;

/**
 * A place you can travel from or to.
 *
 * `id` is whatever the journey planner needs back as `name_origin`/`name_destination`:
 * a global stop id ("9091001000009192"), a `streetID:...`, or a `poiID:...`. It is
 * opaque and must round-trip untouched.
 *
 * `siteId` is only present for stops, and is the *other* SL id space -- the one the
 * departures endpoint wants. Discovering that `site.gid` and the journey planner's
 * global id are the same number is what lets these two halves talk to each other.
 */
export const Place = z.object({
  id: z.string(),
  kind: PlaceKind,
  name: z.string(),
  locality: z.string().nullable().default(null),
  lat: z.number(),
  lon: z.number(),
  modes: z.array(TransportMode).default([]),
  siteId: z.number().int().nullable().default(null),
  /** Set when the place came from the local catalog rather than a live lookup. */
  cached: z.boolean().default(false),
  /** Metres from the search origin, when the search was positional. */
  distanceMetres: z.number().nullable().default(null),
});
export type Place = z.infer<typeof Place>;

export const LineRef = z.object({
  id: z.number().int().nullable().default(null),
  designation: z.string(),
  name: z.string().nullable().default(null),
  mode: TransportMode,
  groupOfLines: z.string().nullable().default(null),
});
export type LineRef = z.infer<typeof LineRef>;

export const DepartureState = z.enum([
  "EXPECTED",
  "ATSTOP",
  "DEPARTED",
  "CANCELLED",
  "UNKNOWN",
]);
export type DepartureState = z.infer<typeof DepartureState>;

export const Departure = z.object({
  /** Stable within a single response; used as a React key and for diffing over SSE. */
  key: z.string(),
  destination: z.string(),
  direction: z.string().nullable().default(null),
  directionCode: z.number().int().nullable().default(null),
  /** SL's own countdown string ("Nu", "3 min", "23:50"). Kept because it is the one
   *  piece of formatting SL gets right, including the "Nu" edge case. */
  display: z.string(),
  state: DepartureState,
  scheduled: Instant,
  expected: Instant.nullable().default(null),
  /** Positive = late. Null when there is no realtime estimate. */
  delaySeconds: z.number().int().nullable().default(null),
  line: LineRef,
  stopAreaName: z.string().nullable().default(null),
  stopPointName: z.string().nullable().default(null),
  platform: z.string().nullable().default(null),
  journeyId: z.number().int().nullable().default(null),
  deviationNotes: z.array(z.string()).default([]),
});
export type Departure = z.infer<typeof Departure>;

export const DeviationSeverity = z.enum(["info", "minor", "major", "severe"]);
export type DeviationSeverity = z.infer<typeof DeviationSeverity>;

export const Deviation = z.object({
  id: z.number().int(),
  severity: DeviationSeverity,
  /** SL's raw 1..10 importance, kept for sorting within a severity bucket. */
  importance: z.number().int(),
  header: z.string(),
  details: z.string(),
  weblink: z.string().nullable().default(null),
  from: Instant.nullable().default(null),
  upto: Instant.nullable().default(null),
  modified: Instant.nullable().default(null),
  lines: z.array(LineRef).default([]),
  stopAreaIds: z.array(z.number().int()).default([]),
  stopAreaNames: z.array(z.string()).default([]),
});
export type Deviation = z.infer<typeof Deviation>;

export const StopCall = z.object({
  name: z.string(),
  siteId: z.number().int().nullable().default(null),
  lat: z.number().nullable().default(null),
  lon: z.number().nullable().default(null),
  arrival: Instant.nullable().default(null),
  departure: Instant.nullable().default(null),
  /** True for the leg's own boarding/alighting stops, false for pass-throughs. */
  isEndpoint: z.boolean().default(false),
});
export type StopCall = z.infer<typeof StopCall>;

export const Occupancy = z.enum([
  "EMPTY",
  "MANY_SEATS",
  "FEW_SEATS",
  "STANDING_ONLY",
  "CRUSHED",
  "FULL",
  "UNKNOWN",
]);
export type Occupancy = z.infer<typeof Occupancy>;

export const JourneyLeg = z.object({
  index: z.number().int(),
  mode: TransportMode,
  line: LineRef.nullable().default(null),
  towards: z.string().nullable().default(null),
  /** Names the vehicle run, independent of boarding stop. Null for walks and when SL omits it. */
  tripId: z.string().nullable().default(null),
  origin: z.object({
    name: z.string(),
    platform: z.string().nullable().default(null),
    lat: z.number().nullable().default(null),
    lon: z.number().nullable().default(null),
    siteId: z.number().int().nullable().default(null),
    scheduled: Instant.nullable().default(null),
    expected: Instant.nullable().default(null),
  }),
  destination: z.object({
    name: z.string(),
    platform: z.string().nullable().default(null),
    lat: z.number().nullable().default(null),
    lon: z.number().nullable().default(null),
    siteId: z.number().int().nullable().default(null),
    scheduled: Instant.nullable().default(null),
    expected: Instant.nullable().default(null),
  }),
  durationSeconds: z.number().int(),
  /** [lon, lat] pairs, GeoJSON order, ready to hand to MapLibre. */
  path: z.array(z.tuple([z.number(), z.number()])).default([]),
  intermediateStops: z.array(StopCall).default([]),
  occupancy: Occupancy.default("UNKNOWN"),
  isRealtime: z.boolean().default(false),
  notes: z.array(z.string()).default([]),
});
export type JourneyLeg = z.infer<typeof JourneyLeg>;

export const Journey = z.object({
  id: z.string(),
  departure: Instant.nullable().default(null),
  arrival: Instant.nullable().default(null),
  durationSeconds: z.number().int(),
  /** Duration once realtime is folded in. Differs from `durationSeconds` when delayed. */
  realtimeDurationSeconds: z.number().int().nullable().default(null),
  interchanges: z.number().int(),
  walkSeconds: z.number().int(),
  legs: z.array(JourneyLeg),
  modes: z.array(TransportMode),
  /** True when any leg is cancelled or the journey carries a severe deviation. */
  disrupted: z.boolean().default(false),
});
export type Journey = z.infer<typeof Journey>;

export const VehiclePosition = z.object({
  id: z.string(),
  lat: z.number(),
  lon: z.number(),
  bearing: z.number().nullable().default(null),
  speed: z.number().nullable().default(null),
  mode: TransportMode,
  line: z.string().nullable().default(null),
  tripId: z.string().nullable().default(null),
  destination: z.string().nullable().default(null),
  timestamp: Instant.nullable().default(null),
});
export type VehiclePosition = z.infer<typeof VehiclePosition>;
