import { describe, expect, test } from "bun:test";
import { cached } from "../cache.ts";

describe("cached", () => {
  test("overlapping calls for the same key share one upstream call", async () => {
    // The stored answer only helps the request after it, so without this the app asking
    // twice in the same second asks SL twice. A commute is twelve calls, not one.
    let calls = 0;
    const slow = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { n: calls };
    };
    const key = `test:${Math.random()}`;
    const [a, b] = await Promise.all([cached(key, 60, slow), cached(key, 60, slow)]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  test("a failure is retried, not remembered", async () => {
    const key = `test:${Math.random()}`;
    await expect(cached(key, 60, () => Promise.reject(new Error("upstream")))).rejects.toThrow();
    expect(await cached(key, 60, () => Promise.resolve("second time"))).toBe("second time");
  });

  test("what one call stored, the next call reads", async () => {
    const key = `test:${Math.random()}`;
    expect(await cached(key, 60, () => Promise.resolve("stored"))).toBe("stored");
    expect(await cached(key, 60, () => Promise.resolve("not asked for"))).toBe("stored");
  });
});
