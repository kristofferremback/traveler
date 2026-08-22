import { describe, expect, test } from "bun:test";
import { formatDelay, formatDistance, formatDuration, localInputToInstant } from "../format.ts";

describe("localInputToInstant", () => {
  test("reads the picker's value as Stockholm time regardless of the device", () => {
    // A phone in another country must still request an 08:30 Stockholm departure.
    expect(localInputToInstant("2026-08-23T08:30")).toBe("2026-08-23T06:30:00.000Z");
    expect(localInputToInstant("2026-01-15T08:30")).toBe("2026-01-15T07:30:00.000Z");
  });

  test("returns null for an empty or malformed value", () => {
    expect(localInputToInstant("")).toBeNull();
    expect(localInputToInstant("nonsense")).toBeNull();
  });
});

describe("formatting", () => {
  test("durations read the way a Swede would say them", () => {
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(3600)).toBe("1 h");
    expect(formatDuration(3900)).toBe("1 h 5 min");
  });

  test("a delay under a minute is not worth reporting", () => {
    expect(formatDelay(30)).toBeNull();
    expect(formatDelay(null)).toBeNull();
    expect(formatDelay(120)).toBe("+2 min");
    expect(formatDelay(-180)).toBe("-3 min");
  });

  test("distances round to something walkable", () => {
    expect(formatDistance(84)).toBe("80 m");
    expect(formatDistance(1500)).toBe("1.5 km");
    expect(formatDistance(null)).toBeNull();
  });
});
