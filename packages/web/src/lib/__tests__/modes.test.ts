import { describe, expect, test } from "bun:test";
import { MODE_FILTERS, describeModes, modeColor, parseModes, toggleMode } from "../modes.ts";
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

describe("the mode filter", () => {
  const boat = MODE_FILTERS.find((f) => f.label === "Båt")!;
  const bus = MODE_FILTERS.find((f) => f.label === "Buss")!;

  test("picking one mode leaves only that mode", () => {
    expect(toggleMode([], boat)).toEqual(["SHIP", "FERRY"]);
    expect(describeModes(toggleMode([], boat))).toBe("Bara båt");
  });

  test("turning the last one off means the whole network again, not an empty search", () => {
    const only = toggleMode([], boat);
    expect(toggleMode(only, boat)).toEqual([]);
    expect(describeModes([])).toBe("Färdmedel");
  });

  test("picking every mode also means the whole network", () => {
    // An allow-list naming all five would still turn närtrafik off upstream, which is
    // not what someone ticking every box is asking for.
    const all = MODE_FILTERS.reduce<ReturnType<typeof toggleMode>>((m, f) => toggleMode(m, f), []);
    expect(all).toEqual([]);
  });

  test("leaving one out is said as leaving it out", () => {
    const without = MODE_FILTERS.filter((f) => f !== bus).flatMap((f) => f.modes);
    expect(describeModes(without)).toBe("Utan buss");
  });

  test("two is spelled out and three is counted", () => {
    expect(describeModes(["BUS", "SHIP", "FERRY"])).toBe("Bara buss och båt");
    expect(describeModes(["METRO", "BUS", "TRAIN"])).toBe("3 färdmedel");
  });

  test("båt covers both the pier and the ferry berth", () => {
    // The catalog tells SHIPBER from FERRYBER. Nobody standing on the quay does, and a
    // filter that let one through and not the other would look like a bug.
    expect(parseModes("SHIP,FERRY")).toEqual(["SHIP", "FERRY"]);
    expect(describeModes(["FERRY"])).toBe("Bara båt");
  });

  test("the parameter is read back in the picker's order, and junk is dropped", () => {
    expect(parseModes("SHIP,BUS,WALK,nonsense")).toEqual(["BUS", "SHIP"]);
    expect(parseModes(null)).toEqual([]);
    expect(parseModes("")).toEqual([]);
  });

  test("a link naming every mode is the same as naming none", () => {
    const everything = MODE_FILTERS.flatMap((f) => f.modes).join(",");
    expect(parseModes(everything)).toEqual([]);
  });
});
