import { describe, expect, test } from "bun:test";
import { PlaceNeighbourhoodQuery, UserSettingsPatch } from "@traveler/shared";
import { DEFAULT_SETTINGS, mergeSettings } from "../savedPlaces.ts";

/**
 * The merge is where "my settings" and "just for this link" meet, and it is the one
 * place a spread would quietly write `undefined` over a stored value.
 */
describe("mergeSettings", () => {
  const stored = {
    speedKmh: 7,
    maxWalkMinutes: 25,
    transferPenaltyMinutes: 3,
    walkMultiplier: 1.2,
    catchBufferMinutes: 2,
  };

  test("keeps the stored value when the caller said nothing", () => {
    expect(mergeSettings(stored, {})).toEqual(stored);
  });

  test("an absent key does not blank the stored value", () => {
    // What a partial parsed from a query string looks like: every key present, most of
    // them undefined.
    const fromQuery = {
      speedKmh: undefined,
      maxWalkMinutes: 5,
      transferPenaltyMinutes: undefined,
      walkMultiplier: undefined,
      catchBufferMinutes: undefined,
    };
    expect(mergeSettings(stored, fromQuery)).toEqual({ ...stored, maxWalkMinutes: 5 });
  });

  test("an override wins, including a legitimate zero", () => {
    expect(mergeSettings(stored, { transferPenaltyMinutes: 0 }).transferPenaltyMinutes).toBe(0);
  });

  test("the defaults are the schema's own", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      speedKmh: 6,
      maxWalkMinutes: 20,
      transferPenaltyMinutes: 5,
      walkMultiplier: 1,
      catchBufferMinutes: 1,
    });
  });
});

/**
 * The trap this pair of schemas exists to avoid: `.partial()` makes a field optional
 * but keeps its default, so an empty query parsed back as all five defaults and a
 * one-field patch reset the other four. Every stored setting was silently unsettable.
 */
describe("settings overrides carry no defaults", () => {
  test("a patch is only the field it names", () => {
    expect(UserSettingsPatch.parse({ maxWalkMinutes: 5 })).toEqual({ maxWalkMinutes: 5 });
    expect(UserSettingsPatch.parse({})).toEqual({});
  });

  test("an empty neighbourhood query overrides nothing", () => {
    expect(PlaceNeighbourhoodQuery.parse({})).toEqual({ isochrones: false });
  });

  test("what the caller did say still arrives, coerced", () => {
    expect(PlaceNeighbourhoodQuery.parse({ speedKmh: "7", isochrones: "true" })).toEqual({
      speedKmh: 7,
      isochrones: true,
    });
  });
});
