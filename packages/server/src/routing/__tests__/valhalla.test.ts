import { afterEach, describe, expect, test } from "bun:test";
import { MAX_ROUTE_LOCATIONS, walkRoutes } from "../valhalla.ts";

/**
 * The regression this guards: the public instance refuses a `/route` with more than ten
 * locations (error 150), and packing ten pairs per request sent twenty. Anywhere with
 * more than five walkable stops, which is every city block, failed to plan at all.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Sent = { locations: unknown[] };

/** Answers every `/route` with one straight leg per consecutive location pair. */
function stubRoutes(): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Sent;
    sent.push(body);
    const legs = body.locations.slice(1).map((_, i) => ({
      // Leg i of request n is recognisable afterwards, so the caller's leg picking is checked too.
      summary: { length: (sent.length * 100 + i) / 1000, time: 1 },
      shape: "",
      maneuvers: [],
    }));
    return new Response(JSON.stringify({ trip: { legs } }), { status: 200 });
  }) as typeof fetch;
  return sent;
}

describe("walkRoutes", () => {
  test("never sends more locations than the public instance accepts", async () => {
    const sent = stubRoutes();
    const pairs = Array.from({ length: 12 }, (_, i) => ({
      from: { lat: 59.3, lon: 18.0 },
      to: { lat: 59.3 + i / 1000, lon: 18.0 },
    }));

    const routes = await walkRoutes(pairs, 6);

    expect(sent.map((s) => s.locations.length)).toEqual([10, 10, 4]);
    for (const s of sent) expect(s.locations.length).toBeLessThanOrEqual(MAX_ROUTE_LOCATIONS);
    // Each pair's own leg, skipping the filler legs between pairs.
    expect(routes.map((r) => r.metres)).toEqual([100, 102, 104, 106, 108, 200, 202, 204, 206, 208, 300, 302]);
  }, 10_000);
});
