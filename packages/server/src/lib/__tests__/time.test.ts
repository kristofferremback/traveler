import { describe, expect, test } from "bun:test";
import { parseSlTime, toInstant, toSlDateTime } from "../time.ts";

describe("parseSlTime", () => {
  test("reads a bare SL timestamp as Stockholm time, not UTC", () => {
    // Summer: CEST is UTC+2. Reading this as UTC would place the departure two hours
    // in the past and make every realtime estimate look wrong.
    expect(toInstant(parseSlTime("2026-08-22T23:50:00"))).toBe("2026-08-22T21:50:00.000Z");
  });

  test("handles winter, when the offset is UTC+1", () => {
    expect(toInstant(parseSlTime("2026-01-15T08:30:00"))).toBe("2026-01-15T07:30:00.000Z");
  });

  test("respects an explicit offset when one is given", () => {
    expect(toInstant(parseSlTime("2026-08-21T07:50:45.257+02:00"))).toBe(
      "2026-08-21T05:50:45.257Z",
    );
  });

  test("passes UTC through unchanged", () => {
    expect(toInstant(parseSlTime("2026-08-22T21:48:42Z"))).toBe("2026-08-22T21:48:42.000Z");
  });

  test("returns null rather than an Invalid Date", () => {
    expect(parseSlTime(null)).toBeNull();
    expect(parseSlTime("")).toBeNull();
    expect(parseSlTime("not a time")).toBeNull();
  });
});

describe("toSlDateTime", () => {
  test("formats as the YYYYMMDD/HHMM the trips endpoint validates against", () => {
    const { date, time } = toSlDateTime(new Date("2026-08-23T06:30:00Z"));
    expect(date).toBe("20260823");
    expect(time).toBe("0830"); // 06:30 UTC is 08:30 in Stockholm
  });

  test("formats midnight as 0000, not 2400", () => {
    const { time } = toSlDateTime(new Date("2026-08-22T22:00:00Z"));
    expect(time).toBe("0000");
  });
});
