import type { CommuteOption, CommuteStatus, JourneyLeg } from "@traveler/shared";
import { formatTime } from "./format";

/**
 * What an option is *now*, on the clock, rather than when the answer was fetched.
 *
 * The engine grades against the moment it was asked. An answer left on screen for
 * twenty minutes still said "Gå nu" for a bus that had gone, which is a lie with a
 * countdown on it. A bus that has left is missed whatever the answer said.
 */
export function liveStatus(option: CommuteOption, now: number): CommuteStatus {
  if (option.status === "missed") return "missed";
  if (new Date(option.boardAt).getTime() < now) return "missed";
  return option.status;
}

/**
 * When to leave, in the words the moment deserves.
 *
 * Minutes while they still mean something to a person standing up to go, a clock time
 * beyond that, and the past tense for a departure that is already gone.
 */
export function leaveLabel(option: CommuteOption, now: number): { big: string; small: string | null } {
  if (liveStatus(option, now) === "missed") return { big: `Gick ${formatTime(option.leaveAt)}`, small: null };
  const minutes = Math.round((new Date(option.leaveAt).getTime() - now) / 60_000);
  if (minutes <= 0) return { big: "Gå nu", small: null };
  if (minutes <= 15) return { big: `${minutes} min`, small: "tills du går" };
  return { big: `Gå ${formatTime(option.leaveAt)}`, small: null };
}

function at(leg: JourneyLeg, end: "origin" | "destination"): number | null {
  const iso = leg[end].expected ?? leg[end].scheduled;
  return iso ? new Date(iso).getTime() : null;
}

/**
 * When the traveller is standing at the stop a leg boards at: the end of whatever
 * brought them there. Walk legs from SL carry no times, only a duration, so the last
 * timed leg is found and the walks after it are added on.
 */
export function arrivalAtLeg(legs: JourneyLeg[], index: number): number | null {
  let walk = 0;
  for (let i = index - 1; i >= 0; i--) {
    const leg = legs[i]!;
    const t = at(leg, "destination");
    if (t !== null) return t + walk * 1000;
    walk += leg.durationSeconds;
  }
  return null;
}

/**
 * A trip that branches off another one at a stop.
 *
 * The part already travelled is the parent's, the rest is an option planned from that
 * stop. The two halves are welded into one option so the map, the list row and the
 * timeline need no second shape. Leaving home is derived: at the first stop it is the
 * new boarding time less the walk there; further along it is unchanged, because the
 * legs before the branch are.
 */
export function splice(parent: CommuteOption, index: number, branch: CommuteOption): CommuteOption {
  const before = parent.journey.legs.slice(0, index);
  const legs = [...before, ...branch.journey.legs].map((leg, i) => ({ ...leg, index: i }));
  const rides = legs.filter((leg) => leg.mode !== "WALK");
  const firstRideBefore = before.some((leg) => leg.mode !== "WALK");

  const boardAt = firstRideBefore ? parent.boardAt : branch.boardAt;
  const leaveAt = firstRideBefore
    ? parent.leaveAt
    : new Date(new Date(branch.boardAt).getTime() - parent.origin.walkSeconds * 1000).toISOString();
  const walkBefore = before.filter((leg) => leg.mode === "WALK").reduce((s, leg) => s + leg.durationSeconds, 0);
  const walkSeconds = parent.origin.walkSeconds + walkBefore + branch.walkSeconds;

  return {
    ...branch,
    id: `${parent.id}+${index}:${branch.id}`,
    journey: {
      ...branch.journey,
      legs,
      interchanges: Math.max(0, rides.length - 1),
      walkSeconds: walkBefore + branch.journey.walkSeconds,
      modes: [...new Set(legs.map((leg) => leg.mode))],
      disrupted: branch.journey.disrupted || before.some((leg) => leg.notes.length > 0),
    },
    leaveAt,
    boardAt,
    origin: parent.origin,
    transfers: Math.max(0, rides.length - 1),
    walkSeconds,
    doorToDoorSeconds: Math.round((new Date(branch.arriveAt).getTime() - new Date(leaveAt).getTime()) / 1000),
    // Branches are never the engine's recommendation; they are the traveller's own pick.
    status: branch.status === "recommended" ? "ok" : branch.status,
  };
}

/** The ride a branch would replace: is it the one the traveller is already on? */
export function sameRide(parent: CommuteOption, index: number, branch: CommuteOption): boolean {
  const mine = parent.journey.legs.slice(index).find((leg) => leg.mode !== "WALK");
  const theirs = branch.journey.legs.find((leg) => leg.mode !== "WALK");
  if (!mine || !theirs) return false;
  if (mine.tripId && theirs.tripId) return mine.tripId === theirs.tripId;
  return (
    mine.line?.designation === theirs.line?.designation &&
    (mine.origin.expected ?? mine.origin.scheduled) === (theirs.origin.expected ?? theirs.origin.scheduled)
  );
}

/**
 * Which of the options planned from a stop can actually be boarded: at a change, the
 * ones leaving after the traveller gets there. At the first stop, all of them -- leaving
 * home earlier is the traveller's to decide, and the row says when.
 */
export function boardable(parent: CommuteOption, index: number, branches: CommuteOption[]): CommuteOption[] {
  const arrival = arrivalAtLeg(parent.journey.legs, index);
  const firstRide = !parent.journey.legs.slice(0, index).some((leg) => leg.mode !== "WALK");
  if (firstRide || arrival === null) return branches;
  return branches.filter((b) => new Date(b.boardAt).getTime() >= arrival);
}
