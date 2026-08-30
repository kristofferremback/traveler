import { describe, expect, test } from "bun:test";
import type { CommuteSettings, Journey, NeighbourStop } from "@traveler/shared";
import { foldDrafts, parseRef, sitesToAsk, type Draft } from "../commute.ts";

const settings: CommuteSettings = {
  speedKmh: 6,
  maxWalkMinutes: 20,
  transferPenaltyMinutes: 5,
  walkMultiplier: 1,
  catchBufferMinutes: 1,
};

const T0 = Date.parse("2026-08-24T15:30:00Z");
const min = (n: number) => n * 60_000;

function stop(
  id: number,
  name: string,
  walkSeconds: number,
  mode: NeighbourStop["mode"] = "BUS",
  siteGid = `909100100000${id}`,
): NeighbourStop {
  return {
    stopPointId: id,
    siteId: id,
    siteGid,
    name,
    mode,
    lat: 59.3,
    lon: 18.1,
    metres: walkSeconds,
    ascentTo: 0,
    ascentFrom: 0,
    secondsTo: walkSeconds,
    secondsFrom: walkSeconds,
    path: [],
  };
}

const jarlaberg = stop(1, "Jarlaberg", 0);
const cylinder = stop(2, "Cylindervägen", 6 * 60);
const trafikplats = stop(3, "Nacka trafikplats", 9 * 60);

const journey: Journey = {
  id: "j",
  departure: null,
  arrival: null,
  durationSeconds: 0,
  realtimeDurationSeconds: null,
  interchanges: 0,
  walkSeconds: 0,
  legs: [],
  modes: ["BUS"],
  disrupted: false,
};

function draft(partial: Partial<Draft> & Pick<Draft, "vehicleKey" | "ourStop">): Draft {
  const boardAt = partial.boardAt ?? T0 + min(5);
  const alightAt = partial.alightAt ?? boardAt + min(20);
  return {
    journey,
    firstTripId: partial.vehicleKey.split(">")[0] ?? null,
    leaveAt: boardAt - partial.ourStop.secondsTo * 1000,
    boardAt,
    alightAt,
    arriveAt: alightAt,
    ourWalk: partial.ourStop.secondsTo,
    farWalk: 0,
    transfers: partial.vehicleKey.split(">").length - 1,
    ...partial,
  };
}

describe("foldDrafts", () => {
  test("the same bus boarded at two stops is one row, boarded where you leave latest", () => {
    // 443 run 133: at Cylindervägen 17:34, at Jarlaberg 17:35. Same bus, same arrival.
    const atCylinder = draft({
      vehicleKey: "443:133",
      ourStop: cylinder,
      boardAt: T0 + min(4),
      alightAt: T0 + min(30),
    });
    const atJarlaberg = draft({
      vehicleKey: "443:133",
      ourStop: jarlaberg,
      boardAt: T0 + min(5),
      alightAt: T0 + min(30),
    });
    const options = foldDrafts([atCylinder, atJarlaberg], "origin", settings, { at: T0, arriveBy: false }, T0);
    expect(options).toHaveLength(1);
    expect(options[0]!.origin.stop?.name).toBe("Jarlaberg");
    expect(options[0]!.alternatives.map((a) => a.stop.name)).toEqual(["Cylindervägen"]);
  });

  test("arriving, you get off where the walk is shortest, never early", () => {
    // Getting off at Cylindervägen would be home 2 minutes sooner on paper.
    const early = draft({
      vehicleKey: "443:133",
      ourStop: { ...cylinder, secondsFrom: 6 * 60 },
      boardAt: T0 + min(5),
      alightAt: T0 + min(24),
      arriveAt: T0 + min(30),
      ourWalk: 6 * 60,
    });
    const through = draft({
      vehicleKey: "443:133",
      ourStop: jarlaberg,
      boardAt: T0 + min(5),
      alightAt: T0 + min(32),
      arriveAt: T0 + min(32),
      ourWalk: 0,
    });
    const options = foldDrafts([early, through], "destination", settings, { at: T0, arriveBy: false }, T0);
    expect(options).toHaveLength(1);
    expect(options[0]!.destination.stop?.name).toBe("Jarlaberg");
    expect(options[0]!.arriveAt).toBe(new Date(T0 + min(32)).toISOString());
    expect(options[0]!.alternatives[0]?.stop.name).toBe("Cylindervägen");
  });

  test("a change off a bus that gets you there on its own is dropped unless it beats the penalty", () => {
    const direct = draft({
      vehicleKey: "443:133",
      ourStop: jarlaberg,
      boardAt: T0 + min(5),
      alightAt: T0 + min(35),
      arriveAt: T0 + min(35),
    });
    // 443 then 465: arrives 3 minutes earlier, costs a change worth 5.
    const pointless = draft({
      vehicleKey: "443:133>465:9",
      ourStop: jarlaberg,
      boardAt: T0 + min(5),
      alightAt: T0 + min(32),
      arriveAt: T0 + min(32),
      transfers: 1,
    });
    // 443 then the metro: arrives 12 minutes earlier, which does pay for the change.
    const worthwhile = draft({
      vehicleKey: "443:133>18:77",
      ourStop: jarlaberg,
      boardAt: T0 + min(5),
      alightAt: T0 + min(23),
      arriveAt: T0 + min(23),
      transfers: 1,
    });
    const options = foldDrafts([direct, pointless, worthwhile], "destination", settings, { at: T0, arriveBy: false }, T0);
    expect(options.map((o) => o.vehicleKey)).toEqual(["443:133>18:77", "443:133"]);
  });

  test("status follows the planned time: missed, tight, recommended, ok", () => {
    const missed = draft({ vehicleKey: "a", ourStop: trafikplats, boardAt: T0 + min(8) }); // leave T0-1
    const tight = draft({ vehicleKey: "b", ourStop: trafikplats, boardAt: T0 + min(9.5) }); // leave T0+0.5
    const best = draft({ vehicleKey: "c", ourStop: jarlaberg, boardAt: T0 + min(3), alightAt: T0 + min(20) });
    const later = draft({ vehicleKey: "d", ourStop: jarlaberg, boardAt: T0 + min(10), alightAt: T0 + min(40) });
    const options = foldDrafts([missed, tight, best, later], "origin", settings, { at: T0, arriveBy: false }, T0);
    expect(options.map((o) => [o.vehicleKey, o.status])).toEqual([
      ["c", "recommended"],
      ["b", "tight"],
      ["d", "ok"],
      ["a", "missed"],
    ]);
  });

  test("the same leave, arrival, stop and changes is one row, whichever line it rides", () => {
    const via13 = draft({ vehicleKey: "13:1>442:5", ourStop: trafikplats, transfers: 1 });
    const via19 = draft({ vehicleKey: "19:2>442:5", ourStop: trafikplats, transfers: 1 });
    const options = foldDrafts([via13, via19], "destination", settings, { at: T0, arriveBy: false }, T0);
    expect(options).toHaveLength(1);
  });

  test("arriving by a deadline, the latest door-leave wins and late arrivals are not offered", () => {
    const deadline = T0 + min(60);
    const early = draft({ vehicleKey: "a", ourStop: jarlaberg, boardAt: T0 + min(10), alightAt: T0 + min(40) });
    const latest = draft({ vehicleKey: "b", ourStop: jarlaberg, boardAt: T0 + min(25), alightAt: T0 + min(58) });
    const late = draft({ vehicleKey: "c", ourStop: jarlaberg, boardAt: T0 + min(30), alightAt: T0 + min(63) });
    const options = foldDrafts([early, latest, late], "origin", settings, { at: deadline, arriveBy: true }, T0);
    expect(options.map((o) => [o.vehicleKey, o.status])).toEqual([
      ["b", "recommended"],
      ["a", "ok"],
    ]);
  });

  test("a deadline tomorrow leaves nothing missed; a deadline now is judged by the clock", () => {
    const gone = draft({ vehicleKey: "a", ourStop: jarlaberg, boardAt: T0 - min(5), alightAt: T0 + min(20) });
    const next = draft({ vehicleKey: "b", ourStop: jarlaberg, boardAt: T0 + min(5), alightAt: T0 + min(30) });
    const tomorrow = foldDrafts([gone, next], "origin", settings, { at: T0 + min(40), arriveBy: true }, T0 - min(24 * 60));
    expect(tomorrow.map((o) => o.status)).toEqual(["recommended", "ok"]);
    const soon = foldDrafts([gone, next], "origin", settings, { at: T0 + min(40), arriveBy: true }, T0);
    expect(soon.map((o) => [o.vehicleKey, o.status])).toEqual([
      ["b", "recommended"],
      ["a", "missed"],
    ]);
  });

  test("planning from earlier than now keeps everything missed since then", () => {
    const longGone = draft({ vehicleKey: "a", ourStop: jarlaberg, boardAt: T0 - min(35), alightAt: T0 - min(5) });
    const gone = draft({ vehicleKey: "b", ourStop: jarlaberg, boardAt: T0 - min(25), alightAt: T0 + min(5) });
    const next = draft({ vehicleKey: "c", ourStop: jarlaberg, boardAt: T0 + min(5), alightAt: T0 + min(30) });
    const fromNow = foldDrafts([longGone, gone, next], "origin", settings, { at: T0, arriveBy: false }, T0);
    expect(fromNow.map((o) => o.vehicleKey)).toEqual(["c"]);
    const fromEarlier = foldDrafts([longGone, gone, next], "origin", settings, { at: T0 - min(30), arriveBy: false }, T0);
    expect(fromEarlier.map((o) => [o.vehicleKey, o.status])).toEqual([
      ["c", "recommended"],
      ["b", "missed"],
    ]);
  });

  test("the transfer penalty ranks one bus above two at roughly the same time", () => {
    const oneBus = draft({ vehicleKey: "443:1", ourStop: jarlaberg, boardAt: T0 + min(5), alightAt: T0 + min(35) });
    const twoBuses = draft({
      vehicleKey: "25M:1>465:2",
      ourStop: jarlaberg,
      boardAt: T0 + min(5),
      alightAt: T0 + min(32),
      arriveAt: T0 + min(32),
      transfers: 1,
    });
    const options = foldDrafts([oneBus, twoBuses], "destination", settings, { at: T0, arriveBy: false }, T0);
    expect(options[0]!.vehicleKey).toBe("443:1");
  });
});

/**
 * `from`/`to` carry three different things in one string. Getting the order wrong is
 * how "place:12" would become a search for a stop named "place:12" in Norrtälje.
 */
describe("parseRef", () => {
  test("reads a saved place reference", () => {
    expect(parseRef("place:12")).toEqual({ kind: "saved", id: 12 });
  });

  test("reads a coordinate", () => {
    expect(parseRef("59.31557,18.16948")).toEqual({
      kind: "coordinate",
      lat: 59.31557,
      lon: 18.16948,
    });
    expect(parseRef("59.31557, 18.16948")).toEqual({
      kind: "coordinate",
      lat: 59.31557,
      lon: 18.16948,
    });
  });

  test("anything else is an opaque place id, untouched", () => {
    expect(parseRef("9091001000009192")).toEqual({ kind: "place", id: "9091001000009192" });
    expect(parseRef("streetID:1234:5678")).toEqual({ kind: "place", id: "streetID:1234:5678" });
    // Not a saved reference: the id has to be a number, and this is a stop named after
    // a place rather than one of ours.
    expect(parseRef("place:home")).toEqual({ kind: "place", id: "place:home" });
  });

  test("a coordinate off the globe is not a coordinate", () => {
    expect(parseRef("95.0,18.0")).toEqual({ kind: "place", id: "95.0,18.0" });
  });
});

describe("sitesToAsk", () => {
  // Kris's own neighbourhood, in walking order: the bus stops are nearer than the pier.
  const near = [
    stop(1, "Jarlaberg", 60),
    stop(2, "Cylindervägen", 360),
    stop(3, "Nacka strand", 480, "BUS", "9091001000001000"),
    stop(4, "Nacka strand (brygga)", 700, "SHIP", "9091001000001000"),
    stop(5, "Nacka trafikplats", 540),
  ];
  const names = (m: Map<string, NeighbourStop>) => [...m.values()].map((s) => s.name);

  test("without a filter, one entry per site, nearest first", () => {
    expect(names(sitesToAsk(near, "origin"))).toEqual([
      "Jarlaberg",
      "Cylindervägen",
      "Nacka strand",
      "Nacka trafikplats",
    ]);
  });

  test("a mode filter drops the stops you would not board", () => {
    expect(names(sitesToAsk(near, "origin", ["SHIP", "FERRY"]))).toEqual(["Nacka strand (brygga)"]);
  });

  test("the filter picks which stop point speaks for a site", () => {
    // Nacka strand is one site with a bus shelter and a pier three minutes further on.
    // The chosen stop is what the request time is shifted by, so a boat search that
    // kept the shelter would ask SL about the wrong minute as well as the wrong walk.
    const boat = sitesToAsk(near, "origin", ["SHIP", "FERRY"]).get("9091001000001000");
    expect(boat?.secondsTo).toBe(700);
  });

  test("nothing to board within walking distance is an empty set, not a wider search", () => {
    expect(sitesToAsk(near, "origin", ["METRO"]).size).toBe(0);
  });

  test("arriving, the sites are ordered by the walk home", () => {
    const homeward = [stop(1, "Jarlaberg", 60), stop(2, "Cylindervägen", 30)];
    expect(names(sitesToAsk(homeward, "destination"))).toEqual(["Cylindervägen", "Jarlaberg"]);
  });
});
