import { z } from "zod";
import { Instant, Journey, Place, TransportMode } from "./domain.ts";

/** Query params are strings on the wire; these coerce and validate in one step. */
const numeric = z.coerce.number();
const int = z.coerce.number().int();

/**
 * How the traveller walks. Everything derived from a neighbourhood (minutes to a stop,
 * which stops count as reachable) is a function of these, so they are inputs to every
 * read rather than baked into stored data.
 */
/**
 * The bounds, kept apart from the defaults.
 *
 * Two schemas are built from these: the settled one, where every field has a default,
 * and the override one, where an absent field stays absent. `.partial()` cannot produce
 * the second -- it makes a field optional but leaves its default in place, so parsing an
 * empty query would hand back all five defaults and quietly overwrite whatever the
 * account had stored.
 */
const speedKmh = numeric.min(2).max(10);
const maxWalkMinutes = int.min(1).max(45);
/** Minutes a change costs in the ranking. One bus beats two at roughly the same time. */
const transferPenaltyMinutes = numeric.min(0).max(60);
/** 1 = a minute walking weighs the same as a minute riding. Exposed, not used to tune yet. */
const walkMultiplier = numeric.min(0).max(5);
/** Minutes of slack before a departure counts as "you can still make it". */
const catchBufferMinutes = numeric.min(0).max(15);

export const WalkSettings = z.object({
  speedKmh: speedKmh.default(6),
  maxWalkMinutes: maxWalkMinutes.default(20),
});
export type WalkSettings = z.infer<typeof WalkSettings>;

export const CommuteSettings = z.object({
  speedKmh: speedKmh.default(6),
  maxWalkMinutes: maxWalkMinutes.default(20),
  transferPenaltyMinutes: transferPenaltyMinutes.default(5),
  walkMultiplier: walkMultiplier.default(1),
  catchBufferMinutes: catchBufferMinutes.default(1),
});
export type CommuteSettings = z.infer<typeof CommuteSettings>;

/** The same fields with nothing filled in: what a caller actually said, and no more. */
export const WalkSettingsOverrides = z.object({
  speedKmh: speedKmh.optional(),
  maxWalkMinutes: maxWalkMinutes.optional(),
});
export type WalkSettingsOverrides = z.infer<typeof WalkSettingsOverrides>;

export const CommuteSettingsOverrides = z.object({
  speedKmh: speedKmh.optional(),
  maxWalkMinutes: maxWalkMinutes.optional(),
  transferPenaltyMinutes: transferPenaltyMinutes.optional(),
  walkMultiplier: walkMultiplier.optional(),
  catchBufferMinutes: catchBufferMinutes.optional(),
});
export type CommuteSettingsOverrides = z.infer<typeof CommuteSettingsOverrides>;

/**
 * A stop point reachable on foot from a place, with the walk described in facts that do
 * not depend on who is walking (metres, climb) plus the minutes at the requested speed.
 *
 * Stop *points*, not sites: the Nacka strand pier is 250 m and a 58 m climb away from
 * the Nacka strand bus stop, and a site centroid would split the difference.
 */
export const NeighbourStop = z.object({
  stopPointId: z.number().int(),
  siteId: z.number().int(),
  /** The journey planner's id for the parent site; what trips are asked with. */
  siteGid: z.string(),
  name: z.string(),
  mode: TransportMode,
  lat: z.number(),
  lon: z.number(),
  /** Street distance place to stop. The reverse walk differs only in climb. */
  metres: z.number(),
  ascentTo: z.number(),
  ascentFrom: z.number(),
  secondsTo: z.number().int(),
  secondsFrom: z.number().int(),
  /** [lon, lat] pairs from the place to the stop, GeoJSON order. */
  path: z.array(z.tuple([z.number(), z.number()])).default([]),
});
export type NeighbourStop = z.infer<typeof NeighbourStop>;

export const Isochrone = z.object({
  minutes: z.number(),
  /** Polygon rings, [lon, lat]. The first ring is the outer boundary. */
  rings: z.array(z.array(z.tuple([z.number(), z.number()]))),
});
export type Isochrone = z.infer<typeof Isochrone>;

export const Neighbourhood = z.object({
  lat: z.number(),
  lon: z.number(),
  settings: WalkSettings,
  stops: z.array(NeighbourStop),
  isochrones: z.array(Isochrone).default([]),
  computedAt: Instant,
});
export type Neighbourhood = z.infer<typeof Neighbourhood>;

/**
 * Reading the neighbourhood of a bare coordinate. The account's stored settings decide
 * it, like every other read; the query may override the two that change what comes back.
 */
export const NeighbourhoodQuery = WalkSettingsOverrides.extend({
  lat: numeric.min(-90).max(90),
  lon: numeric.min(-180).max(180),
  isochrones: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
});
export type NeighbourhoodQuery = z.infer<typeof NeighbourhoodQuery>;

/**
 * A place reference as it travels in a query string: a place id as used everywhere
 * else (stop gid, EFA address/POI id), a bare "lat,lon", or "place:<id>" for one of the
 * caller's own saved places.
 */
export const PlaceRef = z.string().trim().min(1).max(400);

/**
 * The five settings are optional here because an account keeps them.
 *
 * Absent means "use mine"; present means "just for this request". The service merges in
 * that order, so a link that pins a walking speed keeps working and an agent that sends
 * none gets the same answer the app shows.
 */
export const CommuteQuery = CommuteSettingsOverrides.extend({
  from: PlaceRef,
  to: PlaceRef,
  /** ISO instant to plan around. Absent means now. */
  when: z.string().optional(),
  /**
   * Read `when` as the latest arrival instead of the earliest departure. Options are
   * then ranked by how late you can leave and still be there, and anything landing
   * after `when` is left out. Needs `when`.
   */
  arriveBy: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /**
   * How much drawn geometry to send back.
   *
   * The leg paths are most of the bytes in a response and only one option is on the map
   * at a time, so the default carries the recommended option's and empties the rest.
   * `all` is what a client asks for when the traveller picks another row; `none` is for
   * a caller with no map at all.
   */
  paths: z.enum(["recommended", "all", "none"]).default("recommended"),
  /**
   * Which modes may be ridden, as an allow-list. Absent means all of them.
   *
   * An allow-list rather than a block-list because it is the question travellers ask
   * ("just the boat"), and because both shapes reduce to the same thing: everything
   * except the bus is every other mode. It is not only passed to SL. The engine asks
   * about the stops nearest the quiet end, and the pier is further from Kris's door
   * than eleven bus stops, so a boat-only search that filtered the answers instead of
   * the question would spend its whole budget on buses and come back empty.
   */
  modes: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").filter(Boolean) : undefined))
    .pipe(z.array(TransportMode).min(1).optional()),
});
export type CommuteQuery = z.infer<typeof CommuteQuery>;

export const CommuteStatus = z.enum(["recommended", "ok", "tight", "missed"]);
export type CommuteStatus = z.infer<typeof CommuteStatus>;

/** One end of a door-to-door option: which stop, and how long the walk is. */
export const CommuteEnd = z.object({
  stop: NeighbourStop.nullable(),
  walkSeconds: z.number().int(),
  /**
   * True when the walk time is SL's own estimate rather than ours -- the far end of the
   * trip, where SL chose the stop and we have no neighbourhood. SL's figure is scaled to
   * the traveller's speed but is not street-routed by us.
   */
  estimated: z.boolean(),
});
export type CommuteEnd = z.infer<typeof CommuteEnd>;

export const CommuteAlternative = z.object({
  end: z.enum(["origin", "destination"]),
  stop: NeighbourStop,
  leaveAt: Instant,
  arriveAt: Instant,
  walkSeconds: z.number().int(),
});
export type CommuteAlternative = z.infer<typeof CommuteAlternative>;

export const CommuteOption = z.object({
  id: z.string(),
  /** The ride: transit legs plus SL's walk at the far end. Our own walk is described by `origin`/`destination`. */
  journey: Journey,
  /** Identifies the vehicles ridden, independent of where you board or alight. */
  vehicleKey: z.string(),
  leaveAt: Instant,
  boardAt: Instant,
  alightAt: Instant,
  arriveAt: Instant,
  origin: CommuteEnd,
  destination: CommuteEnd,
  transfers: z.number().int(),
  walkSeconds: z.number().int(),
  /** Seconds from leaving one door to arriving at the other. */
  doorToDoorSeconds: z.number().int(),
  /** Lower is better. Arrival plus penalties, in seconds since the query time. */
  score: z.number(),
  status: CommuteStatus,
  /** Same vehicles, other stop to board or alight at. Never ranked above the main row. */
  alternatives: z.array(CommuteAlternative).default([]),
});
export type CommuteOption = z.infer<typeof CommuteOption>;

export const CommuteResponse = z.object({
  from: Place.nullable(),
  to: Place.nullable(),
  /**
   * The saved label each end was named by, when it was named by one.
   *
   * Beside `from`/`to` rather than instead of them: the underlying place is still what
   * was planned with, and the UI needs both to say "Hem (Jarlaberg)".
   */
  fromLabel: z.string().nullable().default(null),
  toLabel: z.string().nullable().default(null),
  /** Which end the neighbourhood was enumerated on; the other end was left to SL. */
  enumerated: z.enum(["origin", "destination"]),
  /** Sorted best first; missed options last. */
  options: z.array(CommuteOption),
  settings: CommuteSettings,
  /** The instant planned around: the earliest departure, or the deadline when `arriveBy`. */
  plannedFrom: Instant,
  arriveBy: z.boolean().default(false),
  fetchedAt: Instant,
  notices: z.array(z.string()).default([]),
});
export type CommuteResponse = z.infer<typeof CommuteResponse>;
