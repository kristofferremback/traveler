import { describe, expect, test } from "bun:test";
import { matchTrip, type Departure } from "../vehicles.ts";
import { parseCsv } from "../../sync/gtfs.ts";
import { modeFromRouteType } from "../../db/gtfs.ts";
import type { TripTimes } from "../../sl/gtfsrt.ts";

const T0 = Date.parse("2026-08-27T15:36:00Z");
const JARLABERG = { lat: 59.3156, lon: 18.1695 };
const stops: Record<string, { lat: number; lon: number }> = {
  "9022001000403001": JARLABERG,
  "9022001000403002": { lat: 59.3157, lon: 18.1697 }, // the other platform, 15 m away
  "9022001000009192": { lat: 59.3196, lon: 18.0722 }, // Slussen
};
const locate = (id: string) => stops[id] ?? null;

const departure: Departure = { lineGid: "9011001044300000", boardAt: T0, ...JARLABERG };

function trip(tripId: string, routeId: string, at: number, stopId = "9022001000403001"): TripTimes {
  return { tripId, routeId, stops: [{ stopId, scheduledDeparture: at }] };
}

describe("matchTrip", () => {
  test("the trip on the line with the planner's departure at the boarding stop", () => {
    const trips = [
      trip("earlier", "9011001044300000", T0 - 10 * 60_000),
      trip("mine", "9011001044300000", T0),
      trip("later", "9011001044300000", T0 + 10 * 60_000),
      trip("other-line", "9011001047100000", T0),
    ];
    expect(matchTrip(departure, trips, locate)).toBe("mine");
  });

  test("a minute of timetable rounding is the same departure; the other platform is the same stop", () => {
    expect(matchTrip(departure, [trip("mine", "9011001044300000", T0 + 60_000, "9022001000403002")], locate)).toBe("mine");
  });

  test("the same minute at a stop across town is not it", () => {
    expect(matchTrip(departure, [trip("elsewhere", "9011001044300000", T0, "9022001000009192")], locate)).toBeNull();
  });

  test("a trip the static join does not know cannot match", () => {
    expect(matchTrip(departure, [{ tripId: "x", routeId: null, stops: [{ stopId: "9022001000403001", scheduledDeparture: T0 }] }], locate)).toBeNull();
  });
});

describe("parseCsv", () => {
  test("handles quoted commas, doubled quotes, CRLF and a BOM", () => {
    const rows = parseCsv('﻿route_id,route_short_name,route_long_name\r\n1,443,"Slussen, Jarlaberg"\r\n2,"25M","Say ""hi"""\r\n');
    expect(rows).toEqual([
      { route_id: "1", route_short_name: "443", route_long_name: "Slussen, Jarlaberg" },
      { route_id: "2", route_short_name: "25M", route_long_name: 'Say "hi"' },
    ]);
  });
});

describe("modeFromRouteType", () => {
  test("SL's extended route types land on our modes", () => {
    expect(modeFromRouteType(700)).toBe("BUS");
    expect(modeFromRouteType(401)).toBe("METRO");
    expect(modeFromRouteType(1000)).toBe("SHIP");
    expect(modeFromRouteType(900)).toBe("TRAM");
    expect(modeFromRouteType(109)).toBe("TRAIN");
    expect(modeFromRouteType(12345)).toBe("UNKNOWN");
  });
});
