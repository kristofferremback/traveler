import { describe, expect, test } from "bun:test";
import { reusableCentre, routable, type Centre } from "../neighbourhood.ts";

/**
 * The regression these two guard: a phone's fix moves several metres while standing
 * still, `centreKey` is a metre wide, so every plan from Min position rebuilt the whole
 * neighbourhood. That is nine routing calls at a second apart before SL is asked
 * anything, on a queue shared by the whole server.
 */

const JARLABERG = { lat: 59.31557, lon: 18.16948 };
const NOW = Date.parse("2026-08-27T15:30:00Z");
const fresh = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();

/** Metres north of Jarlaberg, as a stored centre computed a day ago. */
function centre(metresNorth: number, computedAt = fresh): Centre {
  return { lat: JARLABERG.lat + metresNorth / 111_320, lon: JARLABERG.lon, computedAt };
}

describe("reusableCentre", () => {
  test("a fix a few metres from a stored centre reuses it", () => {
    const hit = reusableCentre([centre(8)], JARLABERG.lat, JARLABERG.lon, NOW);
    expect(hit?.offsetMetres).toBe(8);
  });

  test("the nearest stored centre wins when several are in range", () => {
    const near = centre(4);
    const hit = reusableCentre([centre(40), near, centre(20)], JARLABERG.lat, JARLABERG.lon, NOW);
    expect(hit?.centre).toBe(near);
  });

  test("a centre past the reuse radius does not answer for this fix", () => {
    expect(reusableCentre([centre(80)], JARLABERG.lat, JARLABERG.lon, NOW)).toBeNull();
  });

  test("a centre older than the age limit is recomputed rather than reused", () => {
    const stale = centre(0, new Date(NOW - 90 * 24 * 60 * 60 * 1000).toISOString());
    expect(reusableCentre([stale], JARLABERG.lat, JARLABERG.lon, NOW)).toBeNull();
  });

  test("nothing stored nearby is nothing to reuse", () => {
    expect(reusableCentre([], JARLABERG.lat, JARLABERG.lon, NOW)).toBeNull();
  });
});

describe("routable", () => {
  const candidates = Array.from({ length: 60 }, (_, i) => `stop-${i}`);
  /** Furthest first, so the sort has something to do. */
  const cells = candidates.map((_, i) => ({ metres: (60 - i) * 40, seconds: 0 }));

  test("routes the nearest forty by street distance, nearest first", () => {
    const out = routable(candidates, cells);
    expect(out.length).toBe(40);
    expect(out[0]).toEqual({ candidate: "stop-59", metres: 40 });
    expect(out.at(-1)).toEqual({ candidate: "stop-20", metres: 1600 });
  });

  test("a candidate the matrix could not reach is not routed", () => {
    const out = routable(["a", "b"], [null, { metres: 500, seconds: 300 }]);
    expect(out).toEqual([{ candidate: "b", metres: 500 }]);
  });

  test("a candidate further than the storage limit is not routed", () => {
    const out = routable(["near", "far"], [
      { metres: 900, seconds: 540 },
      { metres: 3400, seconds: 2040 },
    ]);
    expect(out).toEqual([{ candidate: "near", metres: 900 }]);
  });
});
