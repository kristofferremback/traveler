import type { Departure, Journey } from "@traveler/shared";
import type { Draft, Side } from "./commute.ts";

/**
 * Fill the holes SL's planner leaves in a timetable.
 *
 * The journey planner returns only journeys nothing else beats: a departure that leaves
 * earlier and arrives later than some other answer is never returned, at any ask time.
 * That is how the 08:00 boat from Nacka strand vanishes -- a Waxholmsbolaget boat six
 * minutes later lands at Strömkajen sooner, and SL does not know it needs a ticket the
 * traveller has no intention of buying. The departure board has no such opinion: it
 * lists every departure of every line, with realtime.
 *
 * So, for direct rides the engine already has an answer for, the board is the authority
 * on *when* the line goes and the sibling answer is the authority on *how* the ride
 * goes. A board departure of the same line, direction and stop that no answer covers
 * becomes a row of its own: the sibling's journey shifted to the board's slot, the
 * boarding time realtime from the board, everything after it an estimate and marked as
 * one. Direct rides only -- shifting a transfer chain would invent a connection nobody
 * checked.
 */

/** A board departure this close to an answered one is that answer, not a hole. */
const COVERED_TOLERANCE_MS = 90_000;

function ms(iso: string): number {
  return new Date(iso).getTime();
}

function shiftIso(iso: string | null, deltaMs: number): string | null {
  return iso === null ? null : new Date(ms(iso) + deltaMs).toISOString();
}

function firstRide(d: Draft) {
  return d.journey.legs.find((l) => l.mode !== "WALK") ?? null;
}

/**
 * The site whose board covers a draft's boarding: on the enumerated origin side it is
 * our own stop's site; enumerated at the destination, it is wherever SL boarded, which
 * the catalog may or may not recognise.
 */
function boardingSiteId(d: Draft, side: Side): number | null {
  if (side === "origin") return d.ourStop.siteId;
  return firstRide(d)?.origin.siteId ?? null;
}

/** What a draft's ride is, in terms a departure board can be matched against. */
function identity(d: Draft, side: Side) {
  if (d.transfers !== 0) return null;
  const leg = firstRide(d);
  const designation = leg?.line?.designation;
  const towards = leg?.towards;
  const scheduled = leg?.origin.scheduled;
  const siteId = boardingSiteId(d, side);
  if (!leg || !designation || !towards || !scheduled || siteId === null) return null;
  return { leg, designation, mode: leg.mode, towards, scheduled, siteId };
}

/**
 * The sites worth a board request: where the plan's direct rides board, nearest walk
 * first so a cap cuts the least relevant boards.
 *
 * Homeward, `ourWalk` is the walk at the *alighting* end, so the order is only a proxy
 * for which far-side board matters most. Fine while the cap stays above the handful of
 * boarding sites a plan's direct rides actually name.
 */
export function boardSites(drafts: Draft[], side: Side): number[] {
  const walkBySite = new Map<number, number>();
  for (const d of drafts) {
    if (!identity(d, side)) continue;
    const siteId = boardingSiteId(d, side)!;
    const held = walkBySite.get(siteId);
    if (held === undefined || d.ourWalk < held) walkBySite.set(siteId, d.ourWalk);
  }
  return [...walkBySite.entries()].sort((a, b) => a[1] - b[1]).map(([siteId]) => siteId);
}

/**
 * The sibling's journey moved to the board's slot.
 *
 * Scheduled times shift by the timetable delta; the sibling's realtime is its run's,
 * not this one's, so every `expected` is dropped except the boarding, which is the
 * board's own realtime. The boarding leg also takes the board's deviation notes.
 */
function shiftedJourney(journey: Journey, deltaMs: number, board: Departure): Journey {
  let boardingSeen = false;
  const legs = journey.legs.map((leg) => {
    const isBoarding = !boardingSeen && leg.mode !== "WALK";
    if (isBoarding) boardingSeen = true;
    return {
      ...leg,
      origin: {
        ...leg.origin,
        scheduled: isBoarding ? board.scheduled : shiftIso(leg.origin.scheduled, deltaMs),
        expected: isBoarding ? board.expected : null,
      },
      destination: {
        ...leg.destination,
        scheduled: shiftIso(leg.destination.scheduled, deltaMs),
        expected: null,
      },
      intermediateStops: leg.intermediateStops.map((s) => ({
        ...s,
        arrival: shiftIso(s.arrival, deltaMs),
        departure: shiftIso(s.departure, deltaMs),
      })),
      isRealtime: isBoarding && board.expected !== null,
      notes: isBoarding ? [...new Set([...leg.notes, ...board.deviationNotes])] : leg.notes,
    };
  });
  const departure = legs[0] ? (legs[0].origin.expected ?? legs[0].origin.scheduled) : null;
  const last = legs[legs.length - 1];
  const arrival = last ? (last.destination.expected ?? last.destination.scheduled) : null;
  return {
    ...journey,
    id: `${departure ?? "?"}|${arrival ?? "?"}|tidtabell|${board.key}`,
    departure,
    arrival,
    realtimeDurationSeconds: null,
    legs,
  };
}

/**
 * The drafts the boards say are missing: one per uncovered departure of a line,
 * direction and stop some existing direct draft already rides. Pure; the caller fetches
 * the boards and appends what comes back before folding, so the horizon, missed and
 * dedupe rules apply to these rows the same as to SL's own.
 */
export function fillFromBoards(
  drafts: Draft[],
  side: Side,
  boards: Map<number, Departure[]>,
  reference: number,
): Draft[] {
  type Group = { key: string; siteId: number; sibs: { draft: Draft; scheduled: number }[] };
  const groups = new Map<string, Group>();
  /**
   * How far each site's own ask provably looked, across every line it answered for.
   *
   * The boat's shadow is usually another line: the morning the 08:25 vanished, the only
   * 80 the planner admitted to was the 08:10, and what proves it kept reading past 08:25
   * is the Waxholmsbolaget 08:37 it did return from the same pier. So the bound is the
   * site's latest answer, whatever line it belongs to. It stays tight where it needs to:
   * a metro site's answers span minutes, not an hour.
   */
  const horizons = new Map<number, number>();
  for (const d of drafts) {
    const id = identity(d, side);
    if (!id || !boards.has(id.siteId)) continue;
    const at = ms(id.scheduled);
    horizons.set(id.siteId, Math.max(horizons.get(id.siteId) ?? at, at));
    const key = [id.siteId, id.designation, id.mode, id.towards.trim().toLowerCase(), d.ourStop.stopPointId].join("|");
    const group = groups.get(key) ?? { key, siteId: id.siteId, sibs: [] };
    group.sibs.push({ draft: d, scheduled: ms(id.scheduled) });
    groups.set(key, group);
  }

  const filled: Draft[] = [];
  for (const group of groups.values()) {
    const sample = identity(group.sibs[0]!.draft, side)!;
    const matches = (boards.get(group.siteId) ?? []).filter(
      (b) =>
        b.line.designation.trim() === sample.designation.trim() &&
        b.line.mode === sample.mode &&
        b.destination.trim().toLowerCase() === sample.towards.trim().toLowerCase() &&
        b.state !== "CANCELLED" &&
        b.state !== "DEPARTED",
    );
    const covered = group.sibs.map((s) => s.scheduled);
    const horizon = horizons.get(group.siteId)!;
    for (const board of matches) {
      const at = ms(board.scheduled);
      // Above the site's horizon the planner was never asked, so a board row would not be
      // a hole it skipped but an hour of estimated rows nobody asked for, which Senare
      // enumerates properly. Below the fold's own reference the row would be born
      // "missed", and the one departure worth looking back at is the planner's own
      // one-before -- this is also what keeps a Senare-anchored ask from resurrecting
      // the departures it was asked to look past.
      if (at < reference || at > horizon) continue;
      if (covered.some((t) => Math.abs(t - at) <= COVERED_TOLERANCE_MS)) continue;
      covered.push(at);

      let sib = group.sibs[0]!;
      for (const s of group.sibs) {
        if (Math.abs(s.scheduled - at) < Math.abs(sib.scheduled - at)) sib = s;
      }
      const delta = at - sib.scheduled;
      const d = sib.draft;
      const journey = shiftedJourney(d.journey, delta, board);
      const rides = journey.legs.filter((l) => l.mode !== "WALK");
      const firstLeg = rides[0]!;
      const lastLeg = rides[rides.length - 1]!;
      const boardAt = ms(board.expected ?? board.scheduled);
      // The row and the trip it opens must agree, so every instant but the boarding comes
      // off the shifted timetable rather than off the sibling: a sibling that ran five
      // minutes late would otherwise lend this run a delay its own legs deny. Only the
      // walks are borrowed, and a walk lasts the same however its ride is running.
      const rideStart = firstLeg.origin.scheduled ? ms(firstLeg.origin.scheduled) : boardAt;
      const alightAt = lastLeg.destination.scheduled
        ? ms(lastLeg.destination.scheduled)
        : d.alightAt + delta;
      filled.push({
        journey,
        // The no-tripId shape the planner's own keys fall back to, plus the site: the
        // board does not know EFA's trip code, and two sites' boards can hold the same
        // line at the same minute without it being the same vehicle.
        vehicleKey: `${sample.designation}|${sample.towards}|${board.scheduled}|${group.siteId}`,
        firstTripId: null,
        // Boarding follows the board's realtime; the walk to it, and everything on the
        // far side of the ride, follows the timetable.
        leaveAt:
          side === "origin"
            ? boardAt - d.ourWalk * 1000
            : rideStart - (d.boardAt - d.leaveAt),
        boardAt,
        alightAt,
        arriveAt: alightAt + (d.arriveAt - d.alightAt),
        ourStop: d.ourStop,
        ourWalk: d.ourWalk,
        farWalk: d.farWalk,
        transfers: 0,
        timetabled: true,
      });
    }
  }
  return filled;
}
