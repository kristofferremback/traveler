import { describe, expect, test } from "bun:test";
import type { CommuteOption, JourneyLeg } from "@traveler/shared";
import { arrivalAtLeg, boardable, leaveLabel, liveStatus, sameRide, splice } from "../trips";

const T = (hhmm: string) => `2026-08-28T${hhmm}:00+02:00`;
const ms = (hhmm: string) => new Date(T(hhmm)).getTime();

function leg(partial: Partial<JourneyLeg> & { mode: JourneyLeg["mode"] }, index = 0): JourneyLeg {
  const end = { name: "", platform: null, lat: null, lon: null, siteId: null, siteGid: null, scheduled: null, expected: null };
  return {
    index,
    line: partial.mode === "WALK" ? null : { id: null, designation: "25C", name: null, mode: partial.mode, groupOfLines: null },
    towards: null,
    tripId: null,
    origin: { ...end },
    destination: { ...end },
    durationSeconds: 0,
    path: [],
    intermediateStops: [],
    occupancy: "UNKNOWN",
    isRealtime: false,
    notes: [],
    ...partial,
  };
}

const ride = (line: string, from: string, dep: string, to: string, arr: string, tripId = `${line}-${dep}`) =>
  leg({
    mode: "BUS",
    line: { id: null, designation: line, name: null, mode: "BUS", groupOfLines: null },
    tripId,
    origin: { name: from, platform: null, lat: null, lon: null, siteId: 1, siteGid: "9091", scheduled: T(dep), expected: T(dep) },
    destination: { name: to, platform: null, lat: null, lon: null, siteId: 2, siteGid: "9092", scheduled: T(arr), expected: T(arr) },
    durationSeconds: (ms(arr) - ms(dep)) / 1000,
  });
const walk = (seconds: number, to = "") => leg({ mode: "WALK", durationSeconds: seconds, destination: { name: to, platform: null, lat: null, lon: null, siteId: null, siteGid: null, scheduled: null, expected: null } });

function option(legs: JourneyLeg[], p: Partial<CommuteOption> = {}): CommuteOption {
  const rides = legs.filter((l) => l.mode !== "WALK");
  const boardAt = rides[0]!.origin.expected!;
  const alightAt = rides.at(-1)!.destination.expected!;
  return {
    id: p.id ?? "opt",
    journey: { id: "j", departure: boardAt, arrival: alightAt, durationSeconds: 0, realtimeDurationSeconds: null, interchanges: rides.length - 1, walkSeconds: 0, legs: legs.map((l, i) => ({ ...l, index: i })), modes: [], disrupted: false },
    vehicleKey: "v",
    leaveAt: p.leaveAt ?? boardAt,
    boardAt,
    alightAt,
    arriveAt: p.arriveAt ?? alightAt,
    origin: p.origin ?? { stop: null, walkSeconds: 0, estimated: true },
    destination: p.destination ?? { stop: null, walkSeconds: 0, estimated: true },
    transfers: rides.length - 1,
    walkSeconds: p.walkSeconds ?? 0,
    doorToDoorSeconds: 0,
    score: 0,
    status: p.status ?? "ok",
    alternatives: [],
  };
}

/** Home → Nacka trafikplats on foot (8 min), 480C to Slussen, 43 to the office, walk 2 min. */
const home = option([ride("480C", "Nacka trafikplats", "08:22", "Slussen", "08:38"), ride("43", "Slussen", "08:41", "Kungsgatan", "08:48")], {
  id: "home",
  leaveAt: T("08:14"),
  arriveAt: T("08:50"),
  origin: { stop: { stopPointId: 1, siteId: 1, siteGid: "9091", name: "Nacka trafikplats", mode: "BUS", lat: 0, lon: 0, metres: 600, ascentTo: 0, ascentFrom: 0, secondsTo: 480, secondsFrom: 480, path: [] }, walkSeconds: 480, estimated: false },
  destination: { stop: null, walkSeconds: 120, estimated: true },
  walkSeconds: 600,
  status: "recommended",
});

describe("liveStatus", () => {
  test("a bus that has left is missed whatever the answer said", () => {
    expect(liveStatus(home, ms("08:12"))).toBe("recommended");
    expect(liveStatus(home, ms("08:23"))).toBe("missed");
    expect(leaveLabel(home, ms("08:23"))).toEqual({ big: "Gick 08:14", small: null });
  });

  test("the countdown runs until the bus goes, not until the walk should have started", () => {
    expect(leaveLabel(home, ms("08:10"))).toEqual({ big: "4 min", small: "tills du går" });
    expect(leaveLabel(home, ms("08:16")).big).toBe("Gå nu");
    expect(leaveLabel(home, ms("07:30")).big).toBe("Gå 08:14");
  });
});

describe("arrivalAtLeg", () => {
  test("walks carry no times, so the last timed leg plus the walks after it", () => {
    const legs = [ride("480C", "A", "08:22", "B", "08:38"), walk(180), ride("43", "C", "08:45", "D", "08:50")];
    expect(arrivalAtLeg(legs, 2)).toBe(ms("08:41"));
    expect(arrivalAtLeg(legs, 1)).toBe(ms("08:38"));
    expect(arrivalAtLeg(legs, 0)).toBeNull();
  });
});

describe("splice", () => {
  const branch = option([ride("25C", "Nacka trafikplats", "08:24", "Kungsgatan", "08:44")], {
    id: "b1",
    arriveAt: T("08:46"),
    destination: { stop: null, walkSeconds: 120, estimated: true },
    walkSeconds: 120,
    status: "recommended",
  });

  test("at the first stop the walk from home is kept and leaving home moves with the bus", () => {
    const s = splice(home, 0, branch);
    expect(s.journey.legs.map((l) => l.line?.designation)).toEqual(["25C"]);
    expect(s.leaveAt).toBe(new Date(ms("08:24") - 480_000).toISOString());
    expect(s.boardAt).toBe(T("08:24"));
    expect(s.origin).toBe(home.origin);
    expect(s.arriveAt).toBe(T("08:46"));
    expect(s.transfers).toBe(0);
    expect(s.walkSeconds).toBe(600);
    expect(s.status).toBe("ok");
    expect(s.id).toBe("home+0:b1");
  });

  test("at a change the legs before it are kept as they were", () => {
    const later = option([ride("2", "Slussen", "08:44", "Kungsgatan", "08:52")], { id: "b2", arriveAt: T("08:54") });
    const s = splice(home, 1, later);
    expect(s.journey.legs.map((l) => l.line?.designation)).toEqual(["480C", "2"]);
    expect(s.journey.legs.map((l) => l.index)).toEqual([0, 1]);
    expect(s.leaveAt).toBe(home.leaveAt);
    expect(s.boardAt).toBe(home.boardAt);
    expect(s.transfers).toBe(1);
    expect(s.arriveAt).toBe(T("08:54"));
  });
});

describe("boardable", () => {
  const early = option([ride("2", "Slussen", "08:36", "Kungsgatan", "08:44")], { id: "early" });
  const late = option([ride("2", "Slussen", "08:44", "Kungsgatan", "08:52")], { id: "late" });

  test("at a change, only what leaves after the traveller gets there", () => {
    expect(boardable(home, 1, [early, late]).map((o) => o.id)).toEqual(["late"]);
  });

  test("at the first stop, everything: leaving home earlier is the traveller's call", () => {
    expect(boardable(home, 0, [early, late]).map((o) => o.id)).toEqual(["early", "late"]);
  });
});

describe("sameRide", () => {
  test("recognises the ride already on the trip by its trip id", () => {
    const same = option([ride("480C", "Nacka trafikplats", "08:22", "Slussen", "08:38"), ride("43", "Slussen", "08:41", "Kungsgatan", "08:48")]);
    expect(sameRide(home, 0, same)).toBe(true);
    expect(sameRide(home, 0, option([ride("25C", "Nacka trafikplats", "08:24", "Kungsgatan", "08:44")]))).toBe(false);
    expect(sameRide(home, 1, option([ride("43", "Slussen", "08:41", "Kungsgatan", "08:48")]))).toBe(true);
  });
});
