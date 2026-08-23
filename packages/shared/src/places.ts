import { z } from "zod";
import { CommuteSettings, WalkSettings } from "./commute.ts";
import { Instant } from "./domain.ts";

/**
 * A place someone keeps: "Hem", "Jobbet", the pier.
 *
 * `label` is theirs, `name` is the world's -- renaming "Jarlaberg" to "Hem" must not
 * lose which stop it actually is, and the two are shown together everywhere.
 *
 * A saved place is a *reference* to an underlying place wherever one exists (`ref`, the
 * same opaque id every other endpoint uses), plus the coordinate it resolved to. The
 * coordinate is stored rather than looked up on every read because it is the key the
 * walking neighbourhood is computed against, and because an EFA address id that stops
 * resolving must not take a saved place with it.
 */
export const SavedPlaceKind = z.enum(["stop", "address", "poi", "coordinate"]);
export type SavedPlaceKind = z.infer<typeof SavedPlaceKind>;

export const SavedPlace = z.object({
  id: z.number().int(),
  label: z.string(),
  kind: SavedPlaceKind,
  /** Place id for stop/address/poi (site gid or EFA id); null for a bare coordinate. */
  ref: z.string().nullable(),
  name: z.string(),
  lat: z.number(),
  lon: z.number(),
  sortOrder: z.number().int(),
  createdAt: Instant,
  updatedAt: Instant,
});
export type SavedPlace = z.infer<typeof SavedPlace>;

/**
 * Either an existing place id, resolved server-side into kind/name/coordinate, or a
 * bare coordinate. Never both: two sources for the same three fields is two ways for
 * them to disagree.
 */
export const SavedPlaceInput = z
  .object({
    label: z.string().trim().min(1).max(40),
    placeId: z.string().min(1).max(400).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    /** Only for coordinates; an id brings its own name. Defaults to "Egen position". */
    name: z.string().trim().max(120).optional(),
  })
  .refine(
    (v) =>
      v.placeId
        ? v.lat === undefined && v.lon === undefined
        : v.lat !== undefined && v.lon !== undefined,
    { message: "Ange placeId eller lat+lon" },
  );
export type SavedPlaceInput = z.infer<typeof SavedPlaceInput>;

/** What a saved place lets you change: what you call it, and where it sits in the list. */
export const SavedPlacePatch = z
  .object({
    label: z.string().trim().min(1).max(40).optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .refine((v) => v.label !== undefined || v.sortOrder !== undefined, {
    message: "Ange label eller sortOrder",
  });
export type SavedPlacePatch = z.infer<typeof SavedPlacePatch>;

/**
 * The walking settings kept per account.
 *
 * Deliberately the same five fields as `CommuteSettings` rather than a subset: these
 * *are* the commute settings, stored instead of repeated in every query string.
 */
export const UserSettings = CommuteSettings;
export type UserSettings = z.infer<typeof UserSettings>;

export const UserSettingsPatch = CommuteSettings.partial();
export type UserSettingsPatch = z.infer<typeof UserSettingsPatch>;

/**
 * Reading a saved place's neighbourhood. The stored settings decide it; the query may
 * override the two that change what is drawn, so a map can offer "show 30 minutes"
 * without writing that back to the account.
 */
export const PlaceNeighbourhoodQuery = WalkSettings.partial().extend({
  isochrones: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
});
export type PlaceNeighbourhoodQuery = z.infer<typeof PlaceNeighbourhoodQuery>;

export const SavedPlacesResponse = z.object({ places: z.array(SavedPlace) });
export type SavedPlacesResponse = z.infer<typeof SavedPlacesResponse>;

export const SavedPlaceResponse = z.object({ place: SavedPlace });
export type SavedPlaceResponse = z.infer<typeof SavedPlaceResponse>;

export const UserSettingsResponse = z.object({ settings: UserSettings });
export type UserSettingsResponse = z.infer<typeof UserSettingsResponse>;
