import { describe, expect, test } from "bun:test";
import type { CommuteOption, JourneyLeg } from "@traveler/shared";
import {
  accumulate,
  arrivalAtLeg,
  board,
  boardFrom,
  boardable,
  leaveLabel,
  liveStatus,
  sameRide,
  splice,
} from "../trips";

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
    timetabled: p.timetabled ?? false,
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

describe("boardFrom", () => {
  /** Monday, because the bug was a trip picked for Monday answered with Saturday. */
  const mon = (hhmm: string) => `2026-08-31T${hhmm}:00+02:00`;
  const monday = (hhmm: string) => new Date(mon(hhmm)).getTime();
  const saturday = new Date("2026-08-29T16:30:00+02:00").getTime();

  const stop = (name: string, time: string | null) => ({
    name,
    platform: null,
    lat: null,
    lon: null,
    siteId: null,
    siteGid: null,
    scheduled: time,
    expected: time,
  });
  const planned = option(
    [
      leg({ mode: "WALK", durationSeconds: 480, destination: stop("Nacka trafikplats", null) }),
      leg({
        mode: "BUS",
        line: { id: null, designation: "435C", name: null, mode: "BUS", groupOfLines: null },
        origin: stop("Nacka trafikplats", mon("08:11")),
        destination: stop("Cityterminalen", mon("08:33")),
        durationSeconds: 22 * 60,
      }),
    ],
    { id: "planned", leaveAt: mon("08:03"), arriveAt: mon("08:40") },
  );
  // The ride is at index 1: the walk to the stop carries no times of its own.
  const ridden = 1;

  test("a trip picked for Monday anchors on Monday, not on the afternoon you asked", () => {
    expect(boardFrom(planned, ridden, saturday)).toBe(monday("07:56"));
  });

  test("standing at the stop on the day, the clock wins", () => {
    expect(boardFrom(planned, ridden, monday("08:09"))).toBe(monday("08:09"));
    expect(boardFrom(planned, ridden, monday("07:40"))).toBe(monday("07:56"));
  });

  test("further along the trip it starts when the traveller gets there", () => {
    expect(boardFrom(home, 1, ms("07:00"))).toBe(ms("08:38"));
    expect(boardFrom(home, 1, ms("08:50"))).toBe(ms("08:50"));
  });
});

describe("accumulate", () => {
  const trip = (id: string, dep: string, status: CommuteOption["status"] = "ok") =>
    option([ride("443", "Nacka strand", dep, "Slussen", "19:04")], { id, status });

  const tonight = { key: "me|hem|arr|19:30", options: [trip("a", "18:50"), trip("b", "18:55")] };

  test("a different time is a different question, and its answer stands alone", () => {
    const monday = [trip("m1", "08:15"), trip("m2", "08:16")];
    const after = accumulate(tonight, "me|hem|arr|mon-09:00", monday, false);
    expect(after.options.map((o) => o.id)).toEqual(["m1", "m2"]);
  });

  test("Tidigare keeps what is on screen and puts the earlier answer above it", () => {
    const earlier = [trip("e1", "18:40"), trip("a", "18:50")];
    const after = accumulate(tonight, "me|hem|dep|18:40", earlier, true);
    // "a" comes from the fresh answer, not the kept copy, so its times are the new ones.
    expect(after.options.map((o) => o.id)).toEqual(["e1", "a", "b"]);
  });

  test("re-asking the same question merges without being told to", () => {
    const after = accumulate(tonight, tonight.key, [trip("c", "19:00")], false);
    expect(after.options.map((o) => o.id)).toEqual(["c", "a", "b"]);
  });

  test("what has gone sinks to the bottom wherever it came from", () => {
    const previous = { key: "k", options: [trip("gone", "18:20", "missed"), trip("b", "18:55")] };
    const after = accumulate(previous, "k", [trip("late", "18:10", "missed"), trip("c", "19:00")], false);
    expect(after.options.map((o) => o.id)).toEqual(["c", "b", "late", "gone"]);
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

describe("board", () => {
  /** One departure from Cityterminalen, named by the line and the minute it goes. */
  const dep = (line: string, at: string, arrive: string, tripId = `${line}-${at}`) =>
    option([ride(line, "Cityterminalen", at, "Nacka trafikplats", arrive, tripId)], {
      id: `${line}@${at}`,
      arriveAt: T(arrive),
    });

  test("two ways of catching the same onward bus is one row, the one you can wait out", () => {
    const via = (metro: string, at: string) =>
      option(
        [
          ride(metro, "T-Centralen", at, "Slussen", "17:30", `trip-${metro}`),
          ride("471", "Slussen", "17:33", "Jarlaberg", "17:56", "trip-471"),
        ],
        { id: `${metro}@${at}`, arriveAt: T("17:59") },
      );
    expect(board([via("18", "17:19"), via("19", "17:21")], 8).map((o) => o.id)).toEqual(["19@17:21"]);
  });

  test("one row per vehicle, keeping the way home that lands first", () => {
    const legs = (arrive: string) => [
      ride("19", "T-Centralen", "17:15", "Slussen", "17:28", "trip-19"),
      ride("443", "Slussen", "17:30", "Jarlaberg", arrive),
    ];
    const slow = option(legs("17:59"), { id: "slow", arriveAt: T("17:59") });
    const quick = option(legs("17:49"), { id: "quick", arriveAt: T("17:49") });
    expect(board([slow, quick], 8).map((o) => o.id)).toEqual(["quick"]);
  });

  test("every line before any line twice, then down the clock", () => {
    // The tunnelbana every two minutes is what buried the C buses on the real board.
    const options = [
      dep("13", "17:10", "17:48"),
      dep("13", "17:12", "17:50"),
      dep("13", "17:14", "17:52"),
      dep("442C", "17:18", "17:41"),
      dep("480C", "17:25", "17:50"),
    ];
    expect(board(options, 4).map((o) => o.id)).toEqual(["13@17:10", "13@17:12", "442C@17:18", "480C@17:25"]);
    expect(board(options, 3).map((o) => o.id)).toEqual(["13@17:10", "442C@17:18", "480C@17:25"]);
  });

  test("keeps what fits when nothing has to be dropped", () => {
    const options = [dep("480C", "17:25", "17:50"), dep("442C", "17:18", "17:41")];
    expect(board(options, 8).map((o) => o.id)).toEqual(["442C@17:18", "480C@17:25"]);
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
