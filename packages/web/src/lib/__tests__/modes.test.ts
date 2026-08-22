import { describe, expect, test } from "bun:test";
import { modeColor } from "../modes.ts";
import { TransportMode } from "@traveler/shared";

describe("modeColor", () => {
  test("returns a literal colour MapLibre can parse, never a CSS variable", () => {
    // A `var(...)` value here does not throw. MapLibre falls back to black and the
    // route line silently renders as a black stripe.
    for (const mode of TransportMode.options) {
      const color = modeColor(mode);
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("splits the metro by line the way the signage does", () => {
    expect(modeColor("METRO", "10")).toBe(modeColor("METRO", "11"));
    expect(modeColor("METRO", "13")).toBe(modeColor("METRO", "14"));
    expect(modeColor("METRO", "17")).toBe(modeColor("METRO", "19"));
    expect(modeColor("METRO", "10")).not.toBe(modeColor("METRO", "13"));
    expect(modeColor("METRO", "13")).not.toBe(modeColor("METRO", "17"));
  });
});
