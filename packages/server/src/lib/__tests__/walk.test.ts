import { describe, expect, test } from "bun:test";
import { ascentDescent, slWalkPercent, walkSeconds } from "../walk.ts";

describe("walkSeconds", () => {
  test("the Nacka strand pier: 982 m and a 58 m climb is a 15 minute walk home", () => {
    // The one real calibration point. Valhalla alone says 9.6 min at 6 km/h.
    const seconds = walkSeconds(982, 58, 6);
    expect(seconds / 60).toBeGreaterThan(15);
    expect(seconds / 60).toBeLessThan(16);
  });

  test("the same walk downhill is flat time only", () => {
    expect(walkSeconds(982, 0, 6)).toBe(589);
  });

  test("speed scales flat time, not the climb", () => {
    expect(walkSeconds(1000, 0, 5)).toBe(720);
    expect(walkSeconds(1000, 0, 6)).toBe(600);
    expect(walkSeconds(0, 10, 6)).toBe(60);
  });

  test("refuses a non-positive speed instead of returning Infinity", () => {
    expect(() => walkSeconds(100, 0, 0)).toThrow(RangeError);
  });
});

describe("slWalkPercent", () => {
  test("6 km/h is about 60 percent of SL's 3.7 km/h baseline", () => {
    expect(slWalkPercent(6)).toBe(62);
  });
  test("stays inside the gateway's 25..400 range", () => {
    expect(slWalkPercent(20)).toBe(25);
    expect(slWalkPercent(0.5)).toBe(400);
  });
});

describe("ascentDescent", () => {
  test("sums only the uphill and downhill parts", () => {
    expect(ascentDescent([10, 15, 12, 20])).toEqual({ ascent: 13, descent: 3 });
    expect(ascentDescent([])).toEqual({ ascent: 0, descent: 0 });
  });
});
