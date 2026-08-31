import { describe, expect, test } from "bun:test";
import type { CommuteSettings, Departure, Journey, JourneyLeg, NeighbourStop } from "@traveler/shared";
import { foldDrafts, type Draft } from "../commute.ts";
import { boardSites, fillFromBoards } from "../timetable.ts";

/**
 * The morning these tests encode: standing near Jarlaberg at 07:47, the board at Nacka
 * strand said the 80 left for Nybroplan at 07:50, 08:00 and 08:10, and SL's planner
 * would only admit to 07:50 and 08:10 -- a Waxholmsbolaget boat at 08:06 beat the 08:00
 * to town, so the planner considered it not worth mentioning.
 */

const T = (hhmm: string) => Date.parse(`2026-08-31T${hhmm}:00+02:00`);
const iso = (hhmm: string) => new Date(T(hhmm)).toISOString();

const pier: NeighbourStop = {
  stopPointId: 41,
  siteId: 4031,
  siteGid: "9091001000004031",
  name: "Nacka strand",
  mode: "SHIP",
  lat: 59.3164,
  lon: 18.1603,
  metres: 600,
  ascentTo: 0,
  ascentFrom: 58,
  secondsTo: 6 * 60,
  secondsFrom: 12 * 60,
  path: [],
};

function boatLeg(departs: string, arrives: string, expected: string | null = null): JourneyLeg {
  return {
    index: 0,
    mode: "SHIP",
    line: { id: null, designation: "80", name: "Pendelbåt 80", mode: "SHIP", groupOfLines: "Pendelbåt" },
    towards: "Nybroplan",
    tripId: `boat80:${departs}`,
    origin: {
      name: "Nacka strand",
      platform: null,
      lat: 59.3164,
      lon: 18.1603,
      siteId: 4031,
      siteGid: "9091001000004031",
      scheduled: iso(departs),
      expected: expected ? iso(expected) : null,
    },
    destination: {
      name: "Nybroplan",
      platform: null,
      lat: 59.3325,
      lon: 18.0765,
      siteId: 8000,
      siteGid: "9091001000008000",
      scheduled: iso(arrives),
      expected: null,
    },
    durationSeconds: (T(arrives) - T(departs)) / 1000,
    path: [[18.16, 59.316], [18.08, 59.332]],
    intermediateStops: [
      {
        name: "Allmänna gränd",
        siteId: null,
        lat: 59.324,
        lon: 18.096,
        arrival: iso(departs.startsWith("07") ? "08:15" : "08:35"),
        departure: iso(departs.startsWith("07") ? "08:16" : "08:36"),
        isEndpoint: false,
      },
    ],
    occupancy: "UNKNOWN",
    isRealtime: expected !== null,
    notes: [],
  };
}

function boatJourney(departs: string, arrives: string): Journey {
  const leg = boatLeg(departs, arrives);
  return {
    id: `j:${departs}`,
    departure: leg.origin.scheduled,
    arrival: leg.destination.scheduled,
    durationSeconds: leg.durationSeconds,
    realtimeDurationSeconds: null,
    interchanges: 0,
    walkSeconds: 6 * 60,
    legs: [leg],
    modes: ["SHIP"],
    disrupted: false,
  };
}

/** A direct boat draft the way `draft()` in commute.ts would build it, origin side. */
function boatDraft(departs: string, arrives: string): Draft {
  return {
    journey: boatJourney(departs, arrives),
    vehicleKey: `boat80:${departs}`,
    firstTripId: `boat80:${departs}`,
    leaveAt: T(departs) - pier.secondsTo * 1000,
    boardAt: T(departs),
    alightAt: T(arrives),
    arriveAt: T(arrives) + 6 * 60 * 1000,
    ourStop: pier,
    ourWalk: pier.secondsTo,
    farWalk: 6 * 60,
    transfers: 0,
  };
}

/**
 * A Waxholmsbolaget answer from the same pier. It is the boat that shadows the 80 in the
 * planner's Pareto set, and the proof of how far that pier's ask actually read.
 */
function waxholmDraft(departs: string, arrives: string): Draft {
  const d = boatDraft(departs, arrives);
  const leg = d.journey.legs[0]!;
  leg.line = { id: null, designation: "4", name: "Waxholmsbolaget", mode: "SHIP", groupOfLines: null };
  leg.towards = "Stockholm (Strömkajen)";
  leg.tripId = `wax4:${departs}`;
  leg.destination.name = "Strömkajen";
  d.vehicleKey = `wax4:${departs}`;
  d.firstTripId = `wax4:${departs}`;
  return d;
}

/** The same boat homeward: boarded in town, alighting at the pier. */
function homeBoatLeg(departs: string, arrives: string): JourneyLeg {
  return {
    index: 1,
    mode: "SHIP",
    line: { id: null, designation: "80", name: "Pendelbåt 80", mode: "SHIP", groupOfLines: "Pendelbåt" },
    towards: "Nacka strand",
    tripId: `boat80:${departs}`,
    origin: {
      name: "Nybroplan",
      platform: null,
      lat: 59.3325,
      lon: 18.0765,
      siteId: 8000,
      siteGid: "9091001000008000",
      scheduled: iso(departs),
      expected: null,
    },
    destination: {
      name: "Nacka strand",
      platform: null,
      lat: 59.3164,
      lon: 18.1603,
      siteId: 4031,
      siteGid: "9091001000004031",
      scheduled: iso(arrives),
      expected: null,
    },
    durationSeconds: (T(arrives) - T(departs)) / 1000,
    path: [[18.08, 59.332], [18.16, 59.316]],
    intermediateStops: [],
    occupancy: "UNKNOWN",
    isRealtime: false,
    notes: [],
  };
}

/** The walk from the office down to the quay, timed, the way the planner emits it. */
function walkToQuay(leaves: string, arrives: string): JourneyLeg {
  return {
    index: 0,
    mode: "WALK",
    line: null,
    towards: null,
    tripId: null,
    origin: {
      name: "Kungsgatan",
      platform: null,
      lat: 59.335,
      lon: 18.06,
      siteId: null,
      siteGid: null,
      scheduled: iso(leaves),
      expected: null,
    },
    destination: {
      name: "Nybroplan",
      platform: null,
      lat: 59.3325,
      lon: 18.0765,
      siteId: 8000,
      siteGid: "9091001000008000",
      scheduled: iso(arrives),
      expected: null,
    },
    durationSeconds: (T(arrives) - T(leaves)) / 1000,
    path: [],
    intermediateStops: [],
    occupancy: "UNKNOWN",
    isRealtime: false,
    notes: [],
  };
}

/** A homeward draft the way `draft()` builds one when the destination is enumerated. */
function homeDraft(leaves: string, departs: string, arrives: string): Draft {
  const walk = walkToQuay(leaves, departs);
  const ride = homeBoatLeg(departs, arrives);
  return {
    journey: {
      id: `home:${departs}`,
      departure: iso(leaves),
      arrival: iso(arrives),
      durationSeconds: (T(arrives) - T(leaves)) / 1000,
      realtimeDurationSeconds: null,
      interchanges: 0,
      walkSeconds: walk.durationSeconds,
      legs: [walk, ride],
      modes: ["WALK", "SHIP"],
      disrupted: false,
    },
    vehicleKey: `boat80:${departs}`,
    firstTripId: ride.tripId,
    leaveAt: T(leaves),
    boardAt: T(departs),
    alightAt: T(arrives),
    arriveAt: T(arrives) + pier.secondsFrom * 1000,
    ourStop: pier,
    ourWalk: pier.secondsFrom,
    farWalk: walk.durationSeconds,
    transfers: 0,
  };
}

function departure(hhmm: string, over: Partial<Departure> = {}): Departure {
  return {
    key: `dep:${hhmm}:${over.destination ?? "Nybroplan"}`,
    destination: "Nybroplan",
    direction: null,
    directionCode: 2,
    display: hhmm,
    state: "EXPECTED",
    scheduled: iso(hhmm),
    expected: null,
    delaySeconds: null,
    line: { id: null, designation: "80", name: null, mode: "SHIP", groupOfLines: null },
    stopAreaName: null,
    stopPointName: null,
    platform: null,
    journeyId: null,
    deviationNotes: [],
    ...over,
  };
}

const siblings = [boatDraft("07:50", "08:31"), boatDraft("08:10", "08:51")];
const board = new Map([[4031, [departure("07:50"), departure("08:00"), departure("08:10")]]]);
/** Standing on the hill at 07:47: the same reference the fold calls "missed" against. */
const asked = T("07:47");

describe("fillFromBoards", () => {
  test("should synthesize the departure the planner left out when the board has it", () => {
    const filled = fillFromBoards(siblings, "origin", board, asked);
    expect(filled).toHaveLength(1);
    const row = filled[0]!;
    expect(row.timetabled).toBe(true);
    expect(row.boardAt).toBe(T("08:00"));
    expect(row.leaveAt).toBe(T("07:54"));
    // Run profile from the nearest sibling: the 07:50 takes 41 minutes to Nybroplan.
    expect(row.alightAt).toBe(T("08:41"));
    expect(row.arriveAt).toBe(T("08:47"));
    expect(row.ourStop.name).toBe("Nacka strand");
    expect(row.transfers).toBe(0);
  });

  test("should shift the whole journey so the timeline and the map read this run's times", () => {
    const row = fillFromBoards(siblings, "origin", board, asked)[0]!;
    const leg = row.journey.legs[0]!;
    expect(leg.origin.scheduled).toBe(iso("08:00"));
    expect(leg.destination.scheduled).toBe(iso("08:41"));
    expect(leg.intermediateStops[0]!.arrival).toBe(iso("08:25"));
    expect(row.journey.departure).toBe(iso("08:00"));
    expect(row.journey.arrival).toBe(iso("08:41"));
    // The sibling's geometry is this run's geometry; the map needs no second shape.
    expect(leg.path.length).toBeGreaterThan(0);
  });

  test("should board on the board's realtime but estimate the rest from the timetable", () => {
    const late = new Map([[4031, [departure("08:00", { expected: iso("08:03") })]]]);
    const row = fillFromBoards(siblings, "origin", late, asked)[0]!;
    expect(row.boardAt).toBe(T("08:03"));
    expect(row.leaveAt).toBe(T("07:57"));
    expect(row.alightAt).toBe(T("08:41"));
    const leg = row.journey.legs[0]!;
    expect(leg.origin.expected).toBe(iso("08:03"));
    // The sibling's own realtime is its run's, not this one's.
    expect(leg.destination.expected).toBeNull();
    expect(leg.isRealtime).toBe(true);
  });

  test("should leave departures the planner already answered alone", () => {
    const answered = new Map([[4031, [departure("07:50"), departure("08:10")]]]);
    expect(fillFromBoards(siblings, "origin", answered, asked)).toHaveLength(0);
  });

  test("should not board a cancelled or already departed run", () => {
    const grim = new Map([
      [4031, [departure("08:00", { state: "CANCELLED" }), departure("08:20", { state: "DEPARTED" })]],
    ]);
    expect(fillFromBoards(siblings, "origin", grim, asked)).toHaveLength(0);
  });

  test("should not match a departure for somewhere else, another line, or another mode", () => {
    const others = new Map([
      [4031, [
        departure("08:00", { destination: "Ropsten" }),
        departure("08:00", { line: { id: null, designation: "4", name: null, mode: "SHIP", groupOfLines: null } }),
        departure("08:00", { line: { id: null, designation: "80", name: null, mode: "BUS", groupOfLines: null } }),
      ]],
    ]);
    expect(fillFromBoards(siblings, "origin", others, asked)).toHaveLength(0);
  });

  test("should fill the planner's holes but never extend past the site's horizon", () => {
    // A line every ten minutes: the board reaches an hour ahead, the answers ten
    // minutes. Only the skipped 08:00 is a hole; the rest is Senare's business.
    const busy = new Map([
      [4031, [departure("08:00"), departure("08:20"), departure("08:30"), departure("08:40")]],
    ]);
    const filled = fillFromBoards(siblings, "origin", busy, asked);
    expect(filled.map((f) => f.boardAt)).toEqual([T("08:00")]);
  });

  test("should fill a hole another line's answer proves the planner read past", () => {
    // The live replay at 08:07: one 80 among the answers, and a Waxholmsbolaget 08:37
    // from the same pier proving the ask read past the 08:25 it skipped. A per-line
    // horizon would leave that boat off the screen, which is the whole bug.
    const answers = [boatDraft("08:10", "08:51"), waxholmDraft("08:37", "09:02")];
    const pier80 = new Map([[4031, [departure("08:25"), departure("08:45")]]]);
    const filled = fillFromBoards(answers, "origin", pier80, T("08:07"));
    expect(filled.map((f) => f.boardAt)).toEqual([T("08:25")]);
    // The 08:45 sits above the site's horizon: nothing the planner was asked about.
    expect(filled.map((f) => f.alightAt)).toEqual([T("09:06")]);
  });

  test("should not synthesize a row the fold would call missed on arrival", () => {
    // The board lists the boats before the traveller stood up. Rows for those would land
    // on the screen already behind them, and looking back is the planner's own job.
    const early = new Map([
      [4031, [departure("07:30"), departure("07:40"), departure("07:50"), departure("08:00"), departure("08:10")]],
    ]);
    const filled = fillFromBoards(siblings, "origin", early, asked);
    expect(filled.map((f) => f.boardAt)).toEqual([T("08:00")]);
    // Below the reference, though still under the site's 08:10 horizon.
    expect(filled.every((f) => f.boardAt >= asked)).toBe(true);
  });

  test("should keep two piers' departures at the same minute apart", () => {
    // The 80 leaving two piers at 08:00 is two boats. One key for both folds them into a
    // single row whose second pier looks like a choice of where to board the same one.
    const quay: NeighbourStop = {
      ...pier,
      stopPointId: 51,
      siteId: 5000,
      siteGid: "9091001000005000",
      name: "Saltsjöqvarn",
    };
    const atQuay = (departs: string, arrives: string): Draft => ({
      ...boatDraft(departs, arrives),
      ourStop: quay,
    });
    const boards = new Map([
      [4031, [departure("08:00")]],
      [5000, [departure("08:00")]],
    ]);
    const filled = fillFromBoards(
      [...siblings, atQuay("07:50", "08:31"), atQuay("08:10", "08:51")],
      "origin",
      boards,
      asked,
    );
    expect(filled).toHaveLength(2);
    expect(new Set(filled.map((f) => f.vehicleKey)).size).toBe(2);
    expect(filled.map((f) => f.ourStop.stopPointId).sort()).toEqual([41, 51]);
  });

  test("should not lend the row a late sibling's delay", () => {
    // The 07:50 ran five minutes behind. Its journey is still the best guess for how the
    // 07:58 rides; its delay belongs to its own run and stays there.
    const late = boatDraft("07:50", "08:31");
    late.journey.legs[0]!.destination.expected = iso("08:36");
    late.journey.arrival = iso("08:36");
    late.alightAt = T("08:36");
    late.arriveAt = T("08:42");
    const drafts = [late, boatDraft("08:10", "08:51")];
    const row = fillFromBoards(drafts, "origin", new Map([[4031, [departure("07:58")]]]), asked)[0]!;
    expect(row.journey.legs[0]!.destination.scheduled).toBe(iso("08:39"));
    expect(row.alightAt).toBe(T("08:39"));
    expect(row.arriveAt).toBe(T("08:45"));
  });

  test("should not fill from a ride with changes: a shifted connection was never checked", () => {
    const withChange = siblings.map((d) => ({ ...d, transfers: 1 }));
    expect(fillFromBoards(withChange, "origin", board, asked)).toHaveLength(0);
  });

  test("should take the run profile from the sibling nearest in time", () => {
    // Evening boats crawl: the 21:10 takes an hour. A 08:00 hole reads the 07:50's run.
    const spread = [boatDraft("07:50", "08:31"), boatDraft("21:10", "22:10")];
    const row = fillFromBoards(spread, "origin", board, asked)[0]!;
    expect(row.alightAt - row.boardAt).toBe(41 * 60_000);
  });

  test("should read the far end's board when the enumerated end is home", () => {
    // Homeward the board is at the far end -- Nybroplan, where SL boarded -- and the
    // pier is only where the ride ends. The walk to the quay comes off the sibling and
    // hangs in front of the new boarding time.
    const homeward = [homeDraft("16:56", "17:00", "17:41"), homeDraft("17:26", "17:30", "18:11")];
    const town = new Map([
      [8000, [
        departure("17:00", { destination: "Nacka strand" }),
        departure("17:10", { destination: "Nacka strand" }),
        departure("17:30", { destination: "Nacka strand" }),
      ]],
    ]);
    expect(boardSites(homeward, "destination")).toEqual([8000]);
    const filled = fillFromBoards(homeward, "destination", town, T("16:50"));
    expect(filled).toHaveLength(1);
    const row = filled[0]!;
    expect(row.boardAt).toBe(T("17:10"));
    expect(row.leaveAt).toBe(T("17:06"));
    expect(row.alightAt).toBe(T("17:51"));
    expect(row.arriveAt).toBe(T("18:03"));
    expect(row.ourStop.stopPointId).toBe(pier.stopPointId);
    expect(row.timetabled).toBe(true);
  });

  test("should fold in with SL's answers, marked, and never duplicate them", () => {
    const settings: CommuteSettings = {
      speedKmh: 6,
      maxWalkMinutes: 20,
      transferPenaltyMinutes: 5,
      walkMultiplier: 1,
      catchBufferMinutes: 1,
    };
    const now = T("07:47");
    const drafts = [...siblings, ...fillFromBoards(siblings, "origin", board, asked)];
    const options = foldDrafts(drafts, "origin", settings, { at: now, arriveBy: false }, now);
    expect(options.map((o) => [o.boardAt, o.timetabled, o.status])).toEqual([
      [iso("08:00"), true, "recommended"],
      [iso("08:10"), false, "ok"],
      [iso("07:50"), false, "missed"],
    ]);
  });
});

describe("boardSites", () => {
  test("should name each direct ride's boarding site once, nearest walk first", () => {
    const shelter: NeighbourStop = { ...pier, stopPointId: 42, siteId: 1234, siteGid: "g", secondsTo: 120 };
    const bus = { ...boatDraft("08:01", "08:20"), ourStop: shelter, ourWalk: 120 };
    expect(boardSites([...siblings, bus], "origin")).toEqual([1234, 4031]);
  });

  test("should skip rides with changes and rides the catalog cannot place", () => {
    const change = { ...boatDraft("08:01", "08:20"), transfers: 1 };
    const unplaced = boatDraft("08:05", "08:25");
    unplaced.journey.legs[0]!.origin.siteId = null;
    expect(boardSites([change], "origin")).toEqual([]);
    expect(boardSites([unplaced], "destination")).toEqual([]);
  });
});
