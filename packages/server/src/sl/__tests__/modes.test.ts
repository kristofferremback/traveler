import { describe, expect, test } from "bun:test";
import { ALL_MOT, motFlags } from "../modes.ts";

describe("motFlags", () => {
  test("no filter sends no flags, which is SL's own default of everything", () => {
    expect(motFlags(undefined)).toEqual({});
    expect(motFlags([])).toEqual({});
  });

  test("a filter names every flag, not only the ones it wants", () => {
    // Every `incl_mot_*` defaults to true upstream, so listing only the wanted ones
    // would widen the search instead of narrowing it and hand back exactly the trips
    // the traveller asked not to see.
    const flags = motFlags(["SHIP"]);
    expect(Object.keys(flags).sort()).toEqual(ALL_MOT.map((m) => `incl_mot_${m}`).sort());
    expect(flags["incl_mot_9"]).toBe(true);
    expect(Object.values(flags).filter(Boolean)).toHaveLength(1);
  });

  test("båt is one flag whichever half of it was asked for", () => {
    expect(motFlags(["SHIP", "FERRY"])).toEqual(motFlags(["SHIP"]));
  });

  test("buss carries närtrafik's buses with it", () => {
    const flags = motFlags(["BUS"]);
    expect(flags["incl_mot_5"]).toBe(true);
    expect(flags["incl_mot_19"]).toBe(true);
    expect(flags["incl_mot_2"]).toBe(false);
  });
});
