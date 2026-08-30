import type {
  CommuteAlternative,
  CommuteOption,
  CommuteQuery,
  CommuteResponse,
  CommuteSettings,
  Journey,
  JourneyLeg,
  NeighbourStop,
  Place,
  TransportMode,
} from "@traveler/shared";
import { cached } from "../db/cache.ts";
import { trips, type TripEndpoint } from "../sl/journeyplanner.ts";
import { resolvePlace } from "./places.ts";
import { getPlace, getSettings, mergeSettings } from "./savedPlaces.ts";
import { attachSiteIds } from "./journeys.ts";
import { getNeighbourhood } from "./neighbourhood.ts";
import { stopPointsNear } from "../db/catalog.ts";
import { AppError, describe } from "../lib/errors.ts";
import { haversineMetres } from "../lib/geo.ts";
import { slWalkPercent } from "../lib/walk.ts";
import { logger } from "../lib/log.ts";

const log = logger("commute");

/**
 * Door-to-door planning between two places, where one end has a walking neighbourhood.
 *
 * SL's planner answers "from A to B" with its own idea of how far you will walk, and it
 * is wrong for a fast walker in a hilly suburb -- it will never propose the boat from
 * the pier, because on its model the climb home takes too long to ever win. So instead
 * of one question, the engine asks one per stop in the neighbourhood, lets SL plan the
 * ride from there, and does the walking arithmetic itself. Then it folds the answers
 * together: one row per vehicle, the sensible place to board or alight, and nothing
 * that Kris would never do (leave a bus that is already taking him home).
 */

/** Upper bound on trip requests per plan; the nearest sites by walk win. */
const MAX_ENUMERATED_SITES = 12;
/** How long a set of SL answers is reused. Two phones asking the same thing share it. */
const TRIPS_CACHE_SECONDS = 45;
/**
 * What one site's question is allowed to cost.
 *
 * The plan waits for the slowest of a dozen parallel requests, so the default budget of
 * fifteen seconds and two retries meant one bad stop could hold the whole screen for
 * three quarters of a minute while eleven answers sat finished. A stop that has not
 * answered in seven seconds is dropped with a notice naming it, which is a better
 * screen than a spinner.
 */
const TRIPS_TIMEOUT_MS = 7_000;
const TRIPS_RETRIES = 1;
/** A boarding/alighting stop further than this from any neighbourhood stop point is not ours. */
const MATCH_TOLERANCE_M = 250;
/** How far from the planned time an option may leave and still be an answer, in either direction. */
const HORIZON_MS = 3 * 60 * 60 * 1000;
/** Crow-fly radius used only to decide which end is the quieter one. */
const DENSITY_RADIUS_M = 1200;
/** How far back "what did I just miss" reaches. */
const LOOKBACK_MS = 20 * 60 * 1000;

type Endpoint = {
  ref: string;
  place: Place | null;
  /** The saved label this end was named by, when it was named by one. */
  label: string | null;
  lat: number;
  lon: number;
};

const COORD = /^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/;
const SAVED = /^place:(\d+)$/;

export type ParsedRef =
  | { kind: "saved"; id: number }
  | { kind: "coordinate"; lat: number; lon: number }
  | { kind: "place"; id: string };

/**
 * What a `from`/`to` string is, before anything is looked up.
 *
 * Pure and exported so the three shapes can be tested without a database or SL. Note
 * the order: "place:12" is checked first because a saved place id is ours to define,
 * and a coordinate second because an SL place id never contains a comma.
 */
export function parseRef(ref: string): ParsedRef {
  const saved = SAVED.exec(ref);
  if (saved) return { kind: "saved", id: Number(saved[1]) };

  const coord = COORD.exec(ref);
  if (coord) {
    const lat = Number(coord[1]);
    const lon = Number(coord[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { kind: "coordinate", lat, lon };
  }
  return { kind: "place", id: ref };
}

async function resolveRef(ref: string, userId: string): Promise<Endpoint> {
  const parsed = parseRef(ref);

  if (parsed.kind === "coordinate") {
    return { ref, place: null, label: null, lat: parsed.lat, lon: parsed.lon };
  }

  if (parsed.kind === "saved") {
    // Ownership is the WHERE clause: someone else's place id is a 404 here, the same
    // 404 as an id that never existed.
    const saved = getPlace(userId, parsed.id);
    if (!saved) throw new AppError("unknown_place", `No saved place matches "${ref}"`, 404);
    if (saved.ref) {
      const place = await resolvePlace(saved.ref);
      // A saved stop plans as the stop it points at, so SL picks the platform. When the
      // underlying id no longer resolves -- an EFA address id can stop existing -- the
      // stored coordinate still does, and planning from it is better than refusing to
      // plan at all. Logged, because a run of these means saved places are decaying.
      if (place) return { ref, place, label: saved.label, lat: place.lat, lon: place.lon };
      log.warn(`saved place ${saved.id} no longer resolves ${saved.ref}; using its coordinate`);
    }
    return { ref, place: null, label: saved.label, lat: saved.lat, lon: saved.lon };
  }

  const place = await resolvePlace(parsed.id);
  if (!place) throw new AppError("unknown_place", `No place matches "${ref}"`, 404);
  return { ref, place, label: null, lat: place.lat, lon: place.lon };
}

function slEndpoint(e: Endpoint): TripEndpoint {
  return e.place ? { id: e.place.id } : { lat: e.lat, lon: e.lon };
}

function instant(leg: JourneyLeg, end: "origin" | "destination"): string | null {
  const p = leg[end];
  return p.expected ?? p.scheduled;
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * Which neighbourhood stop SL's leg boarded or alighted at. SL reports platform
 * coordinates; the neighbourhood holds one stop point per site and mode, so the match
 * is by site first and then by the nearest point of the right mode.
 */
function matchStop(stops: NeighbourStop[], leg: JourneyLeg, end: "origin" | "destination"): NeighbourStop | null {
  const { lat, lon, siteId } = leg[end];
  if (lat === null || lon === null) return null;
  let best: NeighbourStop | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const s of stops) {
    const d = haversineMetres(lat, lon, s.lat, s.lon);
    if (d > MATCH_TOLERANCE_M && s.siteId !== siteId) continue;
    // Same mode beats a nearer point of another mode: the pier is the pier even when
    // the bus shelter is closer to the platform coordinate SL reported.
    const modeBonus = s.mode === leg.mode ? 0 : 1000;
    const siteBonus = s.siteId === siteId ? 0 : 200;
    const score = d + modeBonus + siteBonus;
    if (score < bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

type Side = "origin" | "destination";

export type Draft = {
  journey: Journey;
  vehicleKey: string;
  firstTripId: string | null;
  leaveAt: number;
  boardAt: number;
  alightAt: number;
  arriveAt: number;
  ourStop: NeighbourStop;
  ourWalk: number;
  farWalk: number;
  transfers: number;
};

function sumWalk(legs: JourneyLeg[]): number {
  return legs.filter((l) => l.mode === "WALK").reduce((n, l) => n + l.durationSeconds, 0);
}

/**
 * Turn one SL journey into a door-to-door draft, replacing SL's walk on our side with
 * the neighbourhood's figure. Returns null when the journey has no ride in it, or when
 * SL boarded somewhere outside the neighbourhood (which another query will cover if it
 * is worth covering).
 */
function draft(journey: Journey, side: Side, stops: NeighbourStop[]): Draft | null {
  const legs = journey.legs;
  const firstTransit = legs.findIndex((l) => l.mode !== "WALK");
  if (firstTransit === -1) return null;
  let lastTransit = legs.length - 1;
  while (lastTransit > firstTransit && legs[lastTransit]!.mode === "WALK") lastTransit--;

  const first = legs[firstTransit]!;
  const last = legs[lastTransit]!;
  const boardAtIso = instant(first, "origin");
  const alightAtIso = instant(last, "destination");
  if (!boardAtIso || !alightAtIso) return null;
  const boardAt = ms(boardAtIso);
  const alightAt = ms(alightAtIso);

  const transit = legs.slice(firstTransit, lastTransit + 1);
  const vehicleKey = transit
    .filter((l) => l.mode !== "WALK")
    .map((l) => l.tripId ?? `${l.line?.designation ?? "?"}|${l.towards ?? ""}|${l.origin.scheduled ?? ""}`)
    .join(">");
  const transfers = transit.filter((l) => l.mode !== "WALK").length - 1;

  if (side === "origin") {
    const ourStop = matchStop(stops, first, "origin");
    if (!ourStop) return null;
    const farWalk = sumWalk(legs.slice(lastTransit + 1));
    const arriveAtIso = journey.arrival ?? alightAtIso;
    return {
      journey: { ...journey, legs: legs.slice(firstTransit), walkSeconds: farWalk },
      vehicleKey,
      firstTripId: first.tripId,
      leaveAt: boardAt - ourStop.secondsTo * 1000,
      boardAt,
      alightAt,
      arriveAt: ms(arriveAtIso),
      ourStop,
      ourWalk: ourStop.secondsTo,
      farWalk,
      transfers,
    };
  }

  const ourStop = matchStop(stops, last, "destination");
  if (!ourStop) return null;
  const farWalk = sumWalk(legs.slice(0, firstTransit));
  const leaveAtIso = journey.departure ?? boardAtIso;
  return {
    journey: { ...journey, legs: legs.slice(0, lastTransit + 1), walkSeconds: farWalk },
    vehicleKey,
    firstTripId: first.tripId,
    leaveAt: ms(leaveAtIso),
    boardAt,
    alightAt,
    arriveAt: alightAt + ourStop.secondsFrom * 1000,
    ourStop,
    ourWalk: ourStop.secondsFrom,
    farWalk,
    transfers,
  };
}

/** What the traveller asked about: the earliest they can leave, or the latest they may arrive. */
export type Pivot = { at: number; arriveBy: boolean };

/**
 * Lower is better. Planning forwards, the cost is how long until you are there;
 * planning backwards from a deadline, it is how long before the deadline you have to
 * be out the door. Both in seconds, both carrying the same change and walk penalties,
 * so the transfer rule reads the same in either direction.
 */
function scoreOf(d: Draft, settings: CommuteSettings, pivot: Pivot): number {
  const time = pivot.arriveBy ? (pivot.at - d.leaveAt) / 1000 : (d.arriveAt - pivot.at) / 1000;
  const penalty = d.transfers * settings.transferPenaltyMinutes * 60;
  const walkWeight = (settings.walkMultiplier - 1) * (d.ourWalk + d.farWalk);
  return time + penalty + walkWeight;
}

/**
 * Fold drafts into options: one per vehicle, the right stop on our side, Kris's rules.
 * Pure, so it can be tested with fixtures rather than against a timetable.
 */
export function foldDrafts(
  drafts: Draft[],
  side: Side,
  settings: CommuteSettings,
  pivot: Pivot,
  now: number,
): CommuteOption[] {
  // Group the same ride boarded or left at different stops.
  const groups = new Map<string, Draft[]>();
  for (const d of drafts) {
    const list = groups.get(d.vehicleKey);
    if (list) list.push(d);
    else groups.set(d.vehicleKey, [d]);
  }

  type Folded = { main: Draft; alternatives: CommuteAlternative[]; score: number };
  const folded: Folded[] = [];
  for (const group of groups.values()) {
    // Leaving: board where you can leave home latest. Arriving: get off where the walk
    // is shortest -- never early, even when a timetable says early saves a minute.
    group.sort((a, b) =>
      side === "origin"
        ? b.leaveAt - a.leaveAt || a.ourWalk - b.ourWalk
        : a.ourWalk - b.ourWalk || a.arriveAt - b.arriveAt,
    );
    const main = group[0]!;
    const seen = new Set<number>([main.ourStop.stopPointId]);
    const alternatives: CommuteAlternative[] = [];
    for (const d of group.slice(1)) {
      if (seen.has(d.ourStop.stopPointId)) continue;
      seen.add(d.ourStop.stopPointId);
      alternatives.push({
        end: side,
        stop: d.ourStop,
        leaveAt: new Date(d.leaveAt).toISOString(),
        arriveAt: new Date(d.arriveAt).toISOString(),
        walkSeconds: d.ourWalk,
      });
    }
    folded.push({ main, alternatives, score: scoreOf(main, settings, pivot) });
  }

  // A change that does not pay for itself against staying on the same first vehicle is
  // noise: if the 443 gets you there on its own, "443 then 465" only exists because the
  // timetable pads the 443's last stops. Dropped, not ranked.
  const bestByFirstTrip = new Map<string, Folded>();
  for (const f of folded) {
    const id = f.main.firstTripId;
    if (!id) continue;
    const held = bestByFirstTrip.get(id);
    if (!held || f.main.transfers < held.main.transfers) bestByFirstTrip.set(id, f);
  }
  const kept = folded.filter((f) => {
    const id = f.main.firstTripId;
    if (!id) return true;
    const simpler = bestByFirstTrip.get(id);
    if (!simpler || simpler === f || simpler.main.transfers >= f.main.transfers) return true;
    return f.score < simpler.score;
  });

  // Two rows that leave and arrive at the same minute from the same stop with the same
  // number of changes differ only in an interchangeable leg (the 13 or the 19 to
  // Slussen). One row is the honest amount of choice.
  const equivalent = new Map<string, Folded>();
  for (const f of kept) {
    const key = `${f.main.leaveAt}|${f.main.arriveAt}|${f.main.ourStop.stopPointId}|${f.main.transfers}`;
    const held = equivalent.get(key);
    if (!held || f.score < held.score) equivalent.set(key, f);
  }

  // "Missed" is relative to when the traveller said they would go, which is now unless
  // they asked about a later departure. A deadline says nothing about when they go, so
  // there the clock is the only reference.
  const reference = pivot.arriveBy ? now : Math.max(pivot.at, now);
  const buffer = settings.catchBufferMinutes * 60 * 1000;
  // Forwards, an option is within reach if it leaves within the horizon. Backwards, it
  // has to land by the deadline -- a trip that arrives after "home by 17:00" is not a
  // worse answer to the question, it is no answer -- and leave within the horizon
  // before it.
  const withinReach = (d: Draft) =>
    pivot.arriveBy
      ? d.arriveAt <= pivot.at && d.leaveAt >= pivot.at - HORIZON_MS
      : d.leaveAt <= pivot.at + HORIZON_MS;
  const options: CommuteOption[] = [...equivalent.values()]
    .filter((f) => withinReach(f.main))
    .map((f) => {
    const d = f.main;
    const status =
      d.leaveAt < reference ? "missed" : d.leaveAt < reference + buffer ? "tight" : "ok";
    const ourEnd = { stop: d.ourStop, walkSeconds: d.ourWalk, estimated: false };
    const farEnd = { stop: null, walkSeconds: d.farWalk, estimated: true };
    return {
      id: `${d.vehicleKey}@${d.ourStop.stopPointId}`,
      journey: d.journey,
      vehicleKey: d.vehicleKey,
      leaveAt: new Date(d.leaveAt).toISOString(),
      boardAt: new Date(d.boardAt).toISOString(),
      alightAt: new Date(d.alightAt).toISOString(),
      arriveAt: new Date(d.arriveAt).toISOString(),
      origin: side === "origin" ? ourEnd : farEnd,
      destination: side === "origin" ? farEnd : ourEnd,
      transfers: d.transfers,
      walkSeconds: d.ourWalk + d.farWalk,
      doorToDoorSeconds: Math.round((d.arriveAt - d.leaveAt) / 1000),
      score: Math.round(f.score),
      status,
      alternatives: f.alternatives,
    };
  });

  // Missed rows reach back twenty minutes, or to the planned time when the traveller
  // deliberately asked about earlier than now: "what did I just miss" is the question
  // that a planning time in the past is asking.
  const missedSince = Math.min(pivot.at, reference - LOOKBACK_MS);
  const live = options.filter((o) => o.status !== "missed").sort((a, b) => a.score - b.score);
  const missed = options
    .filter((o) => o.status === "missed" && ms(o.leaveAt) >= missedSince)
    .sort((a, b) => ms(b.leaveAt) - ms(a.leaveAt));
  if (live[0]) live[0].status = "recommended";
  return [...live, ...missed];
}

/**
 * Drop the geometry the caller did not ask for.
 *
 * A shape rather than a mutation: the journeys come out of the response cache, and an
 * option that arrived with its path emptied in place would be served that way to the
 * next caller who asked for all of them.
 */
function withPaths(options: CommuteOption[], mode: CommuteQuery["paths"]): CommuteOption[] {
  if (mode === "all") return options;
  return options.map((option) => {
    if (mode === "recommended" && option.status === "recommended") return option;
    if (!option.journey.legs.some((leg) => leg.path.length > 0)) return option;
    return {
      ...option,
      journey: {
        ...option.journey,
        legs: option.journey.legs.map((leg) => (leg.path.length > 0 ? { ...leg, path: [] } : leg)),
      },
    };
  });
}

/**
 * The sites to ask SL about: one entry per site, nearest on foot first, at most
 * `MAX_ENUMERATED_SITES` of them, and only those you would board.
 *
 * `modes` filters the stop points before the cut rather than the answers afterwards,
 * which is the whole difference between a working boat filter and an empty screen: the
 * Nacka strand pier is further from the door than eleven bus stops, so filtering later
 * would spend the entire budget asking about buses that were never allowed. It also
 * makes the pier the site's representative stop, so the walk the request is shifted by
 * is the walk down to the boat rather than the walk to the shelter.
 */
export function sitesToAsk(
  stops: NeighbourStop[],
  side: Side,
  modes?: TransportMode[],
): Map<string, NeighbourStop> {
  const allowed = modes && modes.length > 0 ? new Set(modes) : null;
  const sites = new Map<string, NeighbourStop>();
  for (const s of [...stops].sort((a, b) =>
    side === "origin" ? a.secondsTo - b.secondsTo : a.secondsFrom - b.secondsFrom,
  )) {
    if (allowed && !allowed.has(s.mode)) continue;
    if (!sites.has(s.siteGid)) sites.set(s.siteGid, s);
    if (sites.size >= MAX_ENUMERATED_SITES) break;
  }
  return sites;
}

export async function planCommute(query: CommuteQuery, userId: string): Promise<CommuteResponse> {
  // The account is the default; the query overrides only what it actually names.
  const settings: CommuteSettings = mergeSettings(getSettings(userId), query);

  let when: Date | undefined;
  if (query.when) {
    when = new Date(query.when);
    if (Number.isNaN(when.getTime())) {
      throw new AppError("invalid_time", `Could not read "${query.when}" as a time.`, 400);
    }
  }
  if (query.arriveBy && !when) {
    throw new AppError("invalid_time", "arriveBy needs a `when` to arrive by.", 400);
  }
  const now = Date.now();
  const plannedFrom = when ? when.getTime() : now;
  const pivot: Pivot = { at: plannedFrom, arriveBy: query.arriveBy };

  const [from, to] = await Promise.all([
    resolveRef(query.from, userId),
    resolveRef(query.to, userId),
  ]);

  // Enumerate the quieter end: that is the suburban end, where the choice of stop is
  // the actual decision, and the cheaper end to ask about. Decided on catalog density
  // so the busy end never costs a routing computation it will not use.
  const fromDensity = stopPointsNear(from.lat, from.lon, DENSITY_RADIUS_M).length;
  const toDensity = stopPointsNear(to.lat, to.lon, DENSITY_RADIUS_M).length;
  const side: Side = fromDensity <= toDensity ? "origin" : "destination";
  const near = side === "origin" ? from : to;
  const far = side === "origin" ? to : from;
  const hood = await getNeighbourhood(near.lat, near.lon, settings);

  const sites = sitesToAsk(hood.stops, side, query.modes);

  const walkPercent = slWalkPercent(settings.speedKmh);
  const notices = new Set<string>();
  if (sites.size === 0) {
    notices.add(
      hood.stops.length === 0
        ? "Inga hållplatser inom gångavstånd."
        : "Inga hållplatser för de valda färdmedlen inom gångavstånd.",
    );
  }

  const results = await Promise.all(
    [...sites.entries()].map(async ([gid, stop]) => {
      // The walk on our side is ours, not SL's, so the moment asked about is shifted by
      // it. Leaving from the enumerated end, you reach each stop at the planned time
      // plus the walk; asking about the planned time itself would list departures you
      // cannot be at the stop for. Arriving at the enumerated end by a deadline, the
      // ride has to be over a walk before it. In the other two cases the walk on our
      // side comes on the far side of the ride from the pivot, and SL's time is the
      // planned one.
      const shifted = pivot.arriveBy ? side === "destination" : side === "origin";
      const askAt = !shifted
        ? when
        : new Date(
            pivot.arriveBy
              ? plannedFrom - stop.secondsFrom * 1000
              : plannedFrom + stop.secondsTo * 1000,
          );
      const params = {
        from: side === "origin" ? { id: gid } : slEndpoint(far),
        to: side === "origin" ? slEndpoint(far) : { id: gid },
        when: askAt,
        arriveBy: pivot.arriveBy,
        results: 3,
        walkPercent,
        maxWalkMinutes: settings.maxWalkMinutes,
        modes: query.modes,
        timeoutMs: TRIPS_TIMEOUT_MS,
        retries: TRIPS_RETRIES,
      };
      const whenKey = askAt ? `${pivot.arriveBy ? "arr" : "dep"}:${askAt.toISOString().slice(0, 16)}` : "now";
      // The mode filter is part of the key, not a detail of the request: two travellers
      // asking about the same stop at the same minute get different answers when one of
      // them is only willing to take the boat.
      const modeKey = query.modes ? [...query.modes].sort().join("+") : "all";
      const key = `commute:${JSON.stringify(params.from)}>${JSON.stringify(params.to)}:${whenKey}:${walkPercent}:${settings.maxWalkMinutes}:${modeKey}`;
      try {
        return await cached(key, TRIPS_CACHE_SECONDS, () => trips(params));
      } catch (err) {
        log.warn(`trips for ${gid} failed: ${describe(err)}`);
        notices.add(`Kunde inte hämta resor via ${sites.get(gid)?.name ?? gid}.`);
        return { journeys: [], notices: [] };
      }
    }),
  );

  const drafts: Draft[] = [];
  const seenJourneys = new Set<string>();
  for (const r of results) {
    for (const n of r.notices) notices.add(n);
    for (const j of r.journeys) {
      const d = draft(attachSiteIds(j), side, hood.stops);
      if (!d) continue;
      // The same SL journey arrives from several site queries when SL walked between
      // them; one copy is enough.
      const sig = `${d.vehicleKey}@${d.ourStop.stopPointId}@${d.boardAt}`;
      if (seenJourneys.has(sig)) continue;
      seenJourneys.add(sig);
      drafts.push(d);
    }
  }

  return {
    from: from.place,
    to: to.place,
    fromLabel: from.label,
    toLabel: to.label,
    enumerated: side,
    options: withPaths(foldDrafts(drafts, side, settings, pivot, now), query.paths),
    settings,
    plannedFrom: new Date(plannedFrom).toISOString(),
    arriveBy: pivot.arriveBy,
    fetchedAt: new Date().toISOString(),
    notices: [...notices],
  };
}
