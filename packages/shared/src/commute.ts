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
export const WalkSettings = z.object({
  speedKmh: numeric.min(2).max(10).default(6),
  maxWalkMinutes: int.min(1).max(45).default(20),
});
export type WalkSettings = z.infer<typeof WalkSettings>;

export const CommuteSettings = WalkSettings.extend({
  /** Minutes a change costs in the ranking. One bus beats two at roughly the same time. */
  transferPenaltyMinutes: numeric.min(0).max(60).default(5),
  /** 1 = a minute walking weighs the same as a minute riding. Exposed, not used to tune yet. */
  walkMultiplier: numeric.min(0).max(5).default(1),
  /** Minutes of slack before a departure counts as "you can still make it". */
  catchBufferMinutes: numeric.min(0).max(15).default(1),
});
export type CommuteSettings = z.infer<typeof CommuteSettings>;

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

export const NeighbourhoodQuery = WalkSettings.extend({
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
 * else (stop gid, EFA address/POI id), or a bare "lat,lon".
 */
export const PlaceRef = z.string().trim().min(1).max(400);

export const CommuteQuery = CommuteSettings.extend({
  from: PlaceRef,
  to: PlaceRef,
  /** ISO instant to plan from. Absent means now. */
  when: z.string().optional(),
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
  /** Which end the neighbourhood was enumerated on; the other end was left to SL. */
  enumerated: z.enum(["origin", "destination"]),
  /** Sorted best first; missed options last. */
  options: z.array(CommuteOption),
  settings: CommuteSettings,
  plannedFrom: Instant,
  fetchedAt: Instant,
  notices: z.array(z.string()).default([]),
});
export type CommuteResponse = z.infer<typeof CommuteResponse>;
