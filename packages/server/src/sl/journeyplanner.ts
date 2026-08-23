import type {
  Journey,
  JourneyLeg,
  Occupancy,
  Place,
  PlaceKind,
  StopCall,
  TransportMode,
} from "@traveler/shared";
import { getJson } from "./http.ts";
import { modeFromProductClass, motFlags, toLonLat } from "./modes.ts";
import { toInstant, toSlDateTime } from "../lib/time.ts";

const BASE = "https://journeyplanner.integration.sl.se/v2";

// ---------------------------------------------------------------------------
// Upstream shapes (EFA / Mentz)
// ---------------------------------------------------------------------------

type EfaCoord = [number, number]; // [lat, lon]

type EfaLocation = {
  id?: string;
  name?: string;
  disassembledName?: string;
  type?: string;
  coord?: EfaCoord;
  matchQuality?: number;
  isBest?: boolean;
  productClasses?: number[];
  parent?: { id?: string; name?: string; type?: string; coord?: EfaCoord } | null;
  properties?: Record<string, unknown> | null;
  departureTimePlanned?: string;
  departureTimeEstimated?: string;
  departureTimeBaseTimetable?: string;
  arrivalTimePlanned?: string;
  arrivalTimeEstimated?: string;
  arrivalTimeBaseTimetable?: string;
};

type EfaTransportation = {
  id?: string;
  name?: string;
  number?: string;
  disassembledName?: string;
  product?: { id?: number; class?: number; name?: string; iconId?: number } | null;
  destination?: { id?: string; name?: string } | null;
  properties?: Record<string, unknown> | null;
};

type EfaLeg = {
  duration?: number;
  origin?: EfaLocation;
  destination?: EfaLocation;
  transportation?: EfaTransportation | null;
  stopSequence?: EfaLocation[] | null;
  coords?: EfaCoord[] | null;
  infos?: { content?: string; subtitle?: string; title?: string }[] | null;
  hints?: { content?: string; infoText?: string }[] | null;
  isRealtimeControlled?: boolean;
  realtimeStatus?: string[] | null;
  properties?: Record<string, unknown> | null;
};

type EfaJourney = {
  tripDuration?: number;
  tripRtDuration?: number;
  interchanges?: number;
  legs?: EfaLeg[] | null;
  isAdditional?: boolean;
};

type EfaSystemMessage = { code?: number; module?: string; text?: string; type?: string };

type StopFinderResponse = {
  locations?: EfaLocation[] | null;
  systemMessages?: EfaSystemMessage[] | null;
};
type TripsResponse = {
  journeys?: EfaJourney[] | null;
  systemMessages?: EfaSystemMessage[] | null;
};

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/** EFA has a dozen location types; travellers only care about three. */
function placeKind(type: string | undefined): PlaceKind | null {
  switch (type) {
    case "stop":
    case "platform":
      return "stop";
    case "poi":
      return "poi";
    case "address":
    case "street":
    case "singlehouse":
      return "address";
    default:
      // `locality` and `suburb` are region names, not somewhere you can board.
      return null;
  }
}

/**
 * EFA labels stops "Stockholm, Slussen" -- locality first. On a phone that wastes the
 * line on a word every result shares, so the locality is split out and the UI decides
 * whether it earns space.
 */
function splitName(loc: EfaLocation): { name: string; locality: string | null } {
  const locality = loc.parent?.type === "locality" ? (loc.parent.name ?? null) : null;
  const disassembled = loc.disassembledName?.trim();
  if (disassembled && loc.type !== "platform") return { name: disassembled, locality };

  const full = loc.name?.trim() ?? "";
  if (locality && full.startsWith(`${locality}, `)) {
    return { name: full.slice(locality.length + 2), locality };
  }
  return { name: full, locality };
}

export function toPlace(loc: EfaLocation): Place | null {
  const kind = placeKind(loc.type);
  const coord = loc.coord;
  if (!kind || !loc.id || !coord) return null;
  const lat = coord[0];
  const lon = coord[1];
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  const { name, locality } = splitName(loc);
  if (!name) return null;

  const modes = [
    ...new Set(
      (loc.productClasses ?? [])
        .map(modeFromProductClass)
        .filter((m): m is TransportMode => m !== "UNKNOWN" && m !== "WALK"),
    ),
  ];

  return {
    id: loc.id,
    kind,
    name,
    locality,
    lat,
    lon,
    modes,
    siteId: null, // Filled in from the local catalog by the route layer.
    cached: false,
    distanceMetres: null,
  };
}

export type StopFinderKinds = { stops?: boolean; addresses?: boolean; pois?: boolean };

/** `any_obj_filter_sf` is a bitmask: 2 stops, 12 streets/addresses, 32 POIs. */
function objFilter(kinds: StopFinderKinds): number {
  let mask = 0;
  if (kinds.stops !== false) mask |= 2;
  if (kinds.addresses !== false) mask |= 12;
  if (kinds.pois !== false) mask |= 32;
  return mask || 46;
}

export async function stopFinder(
  query: string,
  kinds: StopFinderKinds = {},
): Promise<Place[]> {
  const res = await getJson<StopFinderResponse>(`${BASE}/stop-finder`, {
    upstream: "sl-journeyplanner/stop-finder",
    query: { name_sf: query, type_sf: "any", any_obj_filter_sf: objFilter(kinds) },
    timeoutMs: 10_000,
  });
  return (res.locations ?? [])
    .map(toPlace)
    .filter((p): p is Place => p !== null);
}

/**
 * Reverse geocode a coordinate to a street address.
 *
 * The coordinate form is `lon:lat:WGS84[dd.ddddd]` -- longitude first, which is the
 * opposite of the `[lat, lon]` pairs the same API returns. Getting it backwards yields
 * an empty result rather than an error, so it is worth stating once here.
 */
export async function reverseGeocode(lat: number, lon: number): Promise<Place | null> {
  const res = await getJson<StopFinderResponse>(`${BASE}/stop-finder`, {
    upstream: "sl-journeyplanner/reverse-geocode",
    query: {
      name_sf: `${lon.toFixed(6)}:${lat.toFixed(6)}:WGS84[dd.ddddd]`,
      type_sf: "coord",
      any_obj_filter_sf: 46,
    },
    timeoutMs: 8_000,
  });
  for (const loc of res.locations ?? []) {
    const place = toPlace({ ...loc, type: loc.type ?? "address" });
    if (place) return place;
  }
  return null;
}

function occupancyOf(loc: EfaLocation | undefined): Occupancy {
  const raw = String(loc?.properties?.["occupancy"] ?? "").toUpperCase();
  switch (raw) {
    case "EMPTY":
    case "MANY_SEATS":
    case "FEW_SEATS":
    case "STANDING_ONLY":
    case "CRUSHED":
    case "FULL":
      return raw;
    default:
      return "UNKNOWN";
  }
}

/**
 * The traveller-facing platform, or null when there is not one.
 *
 * EFA exposes four overlapping candidates -- `platform`, `platformName`,
 * `stoppingPointPlanned` and `area` -- which disagree with each other. On a single
 * T-Centralen leg the destination reports platform "3" and platformName "1". The
 * reliable signal is the platform location's own `disassembledName`, which is the bay
 * designation ("4") at a station that has numbered bays and repeats the station name
 * where it does not, as at a street tram stop.
 *
 * Walking legs never have a platform, whatever the payload carries over from the
 * previous leg.
 */
function platformOf(loc: EfaLocation | undefined, mode: TransportMode): string | null {
  if (mode === "WALK" || !loc || loc.type !== "platform") return null;
  const designation = loc.disassembledName?.trim();
  if (!designation) return null;
  // Same string as the station means "no distinct platform here".
  return designation === stopName(loc) ? null : designation;
}

function stopName(loc: EfaLocation | undefined): string {
  if (!loc) return "";
  const parent = loc.parent;
  // For a platform, the useful name is the station's, not the bay number.
  const source =
    loc.type === "platform" && parent?.name ? { ...loc, ...parent, type: "stop" } : loc;
  return splitName(source).name || (loc.name ?? "");
}

function toStopCall(loc: EfaLocation, isEndpoint: boolean): StopCall {
  const coord = loc.coord ?? loc.parent?.coord;
  return {
    name: stopName(loc),
    siteId: null,
    lat: coord?.[0] ?? null,
    lon: coord?.[1] ?? null,
    arrival: toInstant(loc.arrivalTimeEstimated ?? loc.arrivalTimePlanned ?? null),
    departure: toInstant(loc.departureTimeEstimated ?? loc.departureTimePlanned ?? null),
    isEndpoint,
  };
}

function legNotes(leg: EfaLeg): string[] {
  const notes = new Set<string>();
  for (const info of leg.infos ?? []) {
    const text = (info.title ?? info.subtitle ?? info.content ?? "").trim();
    if (text) notes.add(text);
  }
  for (const hint of leg.hints ?? []) {
    const text = (hint.content ?? hint.infoText ?? "").trim();
    if (text) notes.add(text);
  }
  return [...notes];
}

/**
 * Identity of the vehicle run a leg rides, independent of where you board or alight.
 *
 * EFA carries a per-line `tripCode` on the transportation properties; with the line's
 * global id and the service day that names one bus. It is what lets two journeys that
 * board the same 443 at different stops be recognised as the same ride.
 */
function tripIdOf(leg: EfaLeg): string | null {
  const props = leg.transportation?.properties ?? {};
  const tripCode = props["tripCode"];
  const lineId = (props["globalId"] as string | undefined) ?? leg.transportation?.id;
  if (tripCode === undefined || tripCode === null || !lineId) return null;
  const day = (leg.origin?.departureTimePlanned ?? "").slice(0, 10);
  return `${lineId}:${String(tripCode)}:${day}`;
}

function toLeg(leg: EfaLeg, index: number): JourneyLeg {
  const productClass = leg.transportation?.product?.class ?? null;
  const mode = modeFromProductClass(productClass);
  const isWalk = mode === "WALK";

  const origin = leg.origin;
  const destination = leg.destination;
  const stops = leg.stopSequence ?? [];

  const path = (leg.coords ?? [])
    .map(toLonLat)
    .filter((c): c is [number, number] => c !== null);

  return {
    index,
    mode,
    line: isWalk
      ? null
      : {
          id: null,
          designation:
            leg.transportation?.disassembledName?.trim() ||
            leg.transportation?.number?.trim() ||
            "",
          name: leg.transportation?.name ?? null,
          mode,
          groupOfLines: leg.transportation?.product?.name ?? null,
        },
    towards: isWalk ? null : (leg.transportation?.destination?.name ?? null),
    tripId: isWalk ? null : tripIdOf(leg),
    origin: {
      name: stopName(origin),
      platform: platformOf(origin, mode),
      lat: origin?.coord?.[0] ?? null,
      lon: origin?.coord?.[1] ?? null,
      siteId: null,
      scheduled: toInstant(origin?.departureTimePlanned ?? null),
      expected: toInstant(origin?.departureTimeEstimated ?? null),
    },
    destination: {
      name: stopName(destination),
      platform: platformOf(destination, mode),
      lat: destination?.coord?.[0] ?? null,
      lon: destination?.coord?.[1] ?? null,
      siteId: null,
      scheduled: toInstant(destination?.arrivalTimePlanned ?? null),
      expected: toInstant(destination?.arrivalTimeEstimated ?? null),
    },
    durationSeconds: leg.duration ?? 0,
    path,
    // The first and last entries of stopSequence are the leg's own endpoints; the UI
    // already shows those, so only the pass-throughs are carried here.
    intermediateStops: stops.slice(1, -1).map((s) => toStopCall(s, false)),
    occupancy: occupancyOf(origin),
    isRealtime: Boolean(leg.isRealtimeControlled),
    notes: legNotes(leg),
  };
}

function toJourney(journey: EfaJourney, index: number): Journey | null {
  const legs = (journey.legs ?? []).map(toLeg);
  if (legs.length === 0) return null;

  const first = legs[0]!;
  const last = legs[legs.length - 1]!;
  const departure = first.origin.expected ?? first.origin.scheduled;
  const arrival = last.destination.expected ?? last.destination.scheduled;

  const modes = [...new Set(legs.map((l) => l.mode).filter((m) => m !== "WALK"))];
  const walkSeconds = legs
    .filter((l) => l.mode === "WALK")
    .reduce((sum, l) => sum + l.durationSeconds, 0);

  return {
    // Stable across a refetch of the same query, so React keys and the map selection
    // survive a poll. Times are part of it because two journeys can share a leg shape.
    id: `${departure ?? "?"}|${arrival ?? "?"}|${legs.map((l) => `${l.mode}${l.line?.designation ?? ""}`).join(">")}|${index}`,
    departure,
    arrival,
    durationSeconds: journey.tripDuration ?? 0,
    realtimeDurationSeconds: journey.tripRtDuration ?? null,
    interchanges: journey.interchanges ?? Math.max(0, modes.length - 1),
    walkSeconds,
    legs,
    modes,
    disrupted: legs.some((l) => l.notes.length > 0),
  };
}

/** A stop/address/POI by the id EFA gave it, or a bare coordinate. */
export type TripEndpoint = { id: string } | { lat: number; lon: number };

export type TripParams = {
  from: TripEndpoint;
  to: TripEndpoint;
  viaId?: string;
  when?: Date;
  arriveBy?: boolean;
  results?: number;
  maxChanges?: number;
  prefer?: "time" | "interchanges" | "walking";
  modes?: TransportMode[];
  language?: "sv" | "en";
  /**
   * Walking time as a percentage of EFA's own (3.7 km/h) baseline, 25..400. Undocumented
   * but validated by the gateway, and the only way to make SL's stop selection agree
   * with a walker who is faster than its default.
   */
  walkPercent?: number;
  /** Longest walk SL may plan to the first or from the last stop, in minutes. */
  maxWalkMinutes?: number;
  /** Only trips at or after the requested time. By default SL includes one before it. */
  oneDirection?: boolean;
};

function endpoint(kind: "origin" | "destination", e: TripEndpoint): Record<string, string> {
  if ("id" in e) return { [`type_${kind}`]: "any", [`name_${kind}`]: e.id };
  // EFA coordinate order is x:y, i.e. lon:lat, in the format its docs spell out.
  return {
    [`type_${kind}`]: "coord",
    [`name_${kind}`]: `${e.lon.toFixed(6)}:${e.lat.toFixed(6)}:WGS84[dd.ddddd]`,
  };
}

const ROUTE_TYPE = {
  time: "leasttime",
  interchanges: "leastinterchange",
  walking: "leastwalking",
} as const;

export type TripResult = { journeys: Journey[]; notices: string[] };

export async function trips(params: TripParams): Promise<TripResult> {
  // `itd_date`/`itd_time` are Stockholm wall-clock in YYYYMMDD/HHMM. The gateway
  // validates them against a regex and rejects ISO strings outright.
  const when = params.when ? toSlDateTime(params.when) : null;

  const res = await getJson<TripsResponse>(`${BASE}/trips`, {
    upstream: "sl-journeyplanner/trips",
    query: {
      ...endpoint("origin", params.from),
      ...endpoint("destination", params.to),
      ...(params.viaId ? { type_via: "any", name_via: params.viaId } : {}),
      calc_number_of_trips: params.results ?? 3,
      max_changes: params.maxChanges ?? 9,
      route_type: ROUTE_TYPE[params.prefer ?? "time"],
      language: params.language ?? "sv",
      gen_c: true, // leg geometry, which is what makes the map worth drawing
      ...(when ? { itd_date: when.date, itd_time: when.time } : {}),
      // Undocumented, but the gateway's own enum validation confirms it exists, and
      // arrive-by is half of what anyone uses a journey planner for.
      ...(params.when ? { itd_trip_date_time_dep_arr: params.arriveBy ? "arr" : "dep" } : {}),
      ...(params.walkPercent !== undefined
        ? { change_speed: Math.min(400, Math.max(25, Math.round(params.walkPercent))) }
        : {}),
      ...(params.maxWalkMinutes !== undefined ? { tr_it_mot_value100: params.maxWalkMinutes } : {}),
      ...(params.oneDirection ? { calc_one_direction: true } : {}),
      ...motFlags(params.modes),
    },
    timeoutMs: 15_000,
  });

  const journeys = (res.journeys ?? [])
    .map(toJourney)
    .filter((j): j is Journey => j !== null);

  const notices = (res.systemMessages ?? [])
    .map((m) => m.text?.trim())
    .filter((t): t is string => Boolean(t));

  return { journeys, notices };
}
