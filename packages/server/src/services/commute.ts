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
} from "@traveler/shared";
import { cached } from "../db/cache.ts";
import { trips, type TripEndpoint } from "../sl/journeyplanner.ts";
import { resolvePlace } from "./places.ts";
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
/** A boarding/alighting stop further than this from any neighbourhood stop point is not ours. */
const MATCH_TOLERANCE_M = 250;
/** Options that would have you leave more than this after the planned time are not "next". */
const HORIZON_MS = 3 * 60 * 60 * 1000;
/** Crow-fly radius used only to decide which end is the quieter one. */
const DENSITY_RADIUS_M = 1200;
/** How far back "what did I just miss" reaches. */
const LOOKBACK_MS = 20 * 60 * 1000;

type Endpoint = {
  ref: string;
  place: Place | null;
  lat: number;
  lon: number;
};

const COORD = /^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/;

async function resolveRef(ref: string): Promise<Endpoint> {
  const m = COORD.exec(ref);
  if (m) {
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { ref, place: null, lat, lon };
  }
  const place = await resolvePlace(ref);
  if (!place) throw new AppError("unknown_place", `No place matches "${ref}"`, 404);
  return { ref, place, lat: place.lat, lon: place.lon };
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

function scoreOf(d: Draft, settings: CommuteSettings, plannedFrom: number): number {
  const arrival = (d.arriveAt - plannedFrom) / 1000;
  const penalty = d.transfers * settings.transferPenaltyMinutes * 60;
  const walkWeight = (settings.walkMultiplier - 1) * (d.ourWalk + d.farWalk);
  return arrival + penalty + walkWeight;
}

/**
 * Fold drafts into options: one per vehicle, the right stop on our side, Kris's rules.
 * Pure, so it can be tested with fixtures rather than against a timetable.
 */
export function foldDrafts(
  drafts: Draft[],
  side: Side,
  settings: CommuteSettings,
  plannedFrom: number,
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
    folded.push({ main, alternatives, score: scoreOf(main, settings, plannedFrom) });
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
  // they asked about a later time.
  const reference = Math.max(plannedFrom, now);
  const buffer = settings.catchBufferMinutes * 60 * 1000;
  const options: CommuteOption[] = [...equivalent.values()]
    .filter((f) => f.main.leaveAt <= plannedFrom + HORIZON_MS)
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

  const live = options.filter((o) => o.status !== "missed").sort((a, b) => a.score - b.score);
  const missed = options
    .filter((o) => o.status === "missed" && ms(o.leaveAt) >= reference - LOOKBACK_MS)
    .sort((a, b) => ms(b.leaveAt) - ms(a.leaveAt));
  if (live[0]) live[0].status = "recommended";
  return [...live, ...missed];
}

export async function planCommute(query: CommuteQuery): Promise<CommuteResponse> {
  const settings: CommuteSettings = {
    speedKmh: query.speedKmh,
    maxWalkMinutes: query.maxWalkMinutes,
    transferPenaltyMinutes: query.transferPenaltyMinutes,
    walkMultiplier: query.walkMultiplier,
    catchBufferMinutes: query.catchBufferMinutes,
  };

  let when: Date | undefined;
  if (query.when) {
    when = new Date(query.when);
    if (Number.isNaN(when.getTime())) {
      throw new AppError("invalid_time", `Could not read "${query.when}" as a time.`, 400);
    }
  }
  const now = Date.now();
  const plannedFrom = when ? when.getTime() : now;

  const [from, to] = await Promise.all([resolveRef(query.from), resolveRef(query.to)]);

  // Enumerate the quieter end: that is the suburban end, where the choice of stop is
  // the actual decision, and the cheaper end to ask about. Decided on catalog density
  // so the busy end never costs a routing computation it will not use.
  const fromDensity = stopPointsNear(from.lat, from.lon, DENSITY_RADIUS_M).length;
  const toDensity = stopPointsNear(to.lat, to.lon, DENSITY_RADIUS_M).length;
  const side: Side = fromDensity <= toDensity ? "origin" : "destination";
  const near = side === "origin" ? from : to;
  const far = side === "origin" ? to : from;
  const hood = await getNeighbourhood(near.lat, near.lon, settings);

  // One request per site, nearest first, covering every mode at that site.
  const sites = new Map<string, NeighbourStop>();
  for (const s of [...hood.stops].sort((a, b) =>
    side === "origin" ? a.secondsTo - b.secondsTo : a.secondsFrom - b.secondsFrom,
  )) {
    if (!sites.has(s.siteGid)) sites.set(s.siteGid, s);
    if (sites.size >= MAX_ENUMERATED_SITES) break;
  }

  const walkPercent = slWalkPercent(settings.speedKmh);
  const notices = new Set<string>();

  const results = await Promise.all(
    [...sites.entries()].map(async ([gid, stop]) => {
      // Leaving from the enumerated end, you reach each stop at the planned time plus
      // the walk, and that is the moment to ask SL about; asking about the planned time
      // itself would list departures you cannot be at the stop for. Arriving at the
      // enumerated end, the walk comes after the ride and SL's time is the planned one.
      const askAt =
        side === "origin" ? new Date(plannedFrom + stop.secondsTo * 1000) : when;
      const params = {
        from: side === "origin" ? { id: gid } : slEndpoint(far),
        to: side === "origin" ? slEndpoint(far) : { id: gid },
        when: askAt,
        results: 3,
        walkPercent,
        maxWalkMinutes: settings.maxWalkMinutes,
      };
      const whenKey = askAt ? askAt.toISOString().slice(0, 16) : "now";
      const key = `commute:${JSON.stringify(params.from)}>${JSON.stringify(params.to)}:${whenKey}:${walkPercent}:${settings.maxWalkMinutes}`;
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
    enumerated: side,
    options: foldDrafts(drafts, side, settings, plannedFrom, now),
    settings,
    plannedFrom: new Date(plannedFrom).toISOString(),
    fetchedAt: new Date().toISOString(),
    notices: [...notices],
  };
}
