import type {
  CommuteSettings,
  SavedPlace,
  SavedPlaceInput,
  SavedPlaceKind,
  SavedPlacePatch,
  UserSettingsPatch,
} from "@traveler/shared";
import { UserSettings } from "@traveler/shared";
import { db } from "../db/index.ts";
import { resolvePlace } from "./places.ts";
import { getNeighbourhood } from "./neighbourhood.ts";
import { AppError, describe } from "../lib/errors.ts";
import { logger } from "../lib/log.ts";

const log = logger("saved-places");

/**
 * A person's own places and walking settings.
 *
 * Every statement here names `user_id` in its WHERE clause. That is the whole ownership
 * model: a row belonging to someone else is not read and then rejected, it is not read
 * at all, so a foreign id and a deleted id are the same 404 and neither leaks the fact
 * that the other person's place exists.
 */

type PlaceRow = {
  id: number;
  label: string;
  kind: string;
  ref: string | null;
  name: string;
  lat: number;
  lon: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

const COLUMNS =
  "id, label, kind, ref, name, lat, lon, sort_order, created_at, updated_at";

const selectAll = db.query<PlaceRow, [string]>(
  `SELECT ${COLUMNS} FROM places WHERE user_id = ?1 ORDER BY sort_order, id`,
);
const selectOne = db.query<PlaceRow, [string, number]>(
  `SELECT ${COLUMNS} FROM places WHERE user_id = ?1 AND id = ?2`,
);
const selectNextOrder = db.query<{ next: number }, [string]>(
  "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM places WHERE user_id = ?1",
);
const insertPlace = db.query<
  PlaceRow,
  [string, string, string, string | null, string, number, number, number, string]
>(
  `INSERT INTO places (user_id, label, kind, ref, name, lat, lon, sort_order, created_at, updated_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
   RETURNING ${COLUMNS}`,
);
const updateLabel = db.query<PlaceRow, [string, number, string | null, number | null, string]>(
  `UPDATE places
      SET label = COALESCE(?3, label),
          sort_order = COALESCE(?4, sort_order),
          updated_at = ?5
    WHERE user_id = ?1 AND id = ?2
    RETURNING ${COLUMNS}`,
);
const deleteOne = db.query<{ id: number }, [string, number]>(
  "DELETE FROM places WHERE user_id = ?1 AND id = ?2 RETURNING id",
);

function toSavedPlace(row: PlaceRow): SavedPlace {
  return {
    id: row.id,
    label: row.label,
    // The column is constrained to the four kinds, so this is a name for the value
    // rather than a claim the database could contradict.
    kind: row.kind as SavedPlaceKind,
    ref: row.ref,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listPlaces(userId: string): SavedPlace[] {
  return selectAll.all(userId).map(toSavedPlace);
}

/** Null for "not yours" and for "not there": the caller cannot tell them apart. */
export function getPlace(userId: string, id: number): SavedPlace | null {
  const row = selectOne.get(userId, id);
  return row ? toSavedPlace(row) : null;
}

export async function createPlace(
  userId: string,
  input: SavedPlaceInput,
): Promise<SavedPlace> {
  let kind: SavedPlaceKind;
  let ref: string | null;
  let name: string;
  let lat: number;
  let lon: number;

  if (input.placeId) {
    const place = await resolvePlace(input.placeId);
    if (!place) {
      throw new AppError("unknown_place", `Ingen plats matchar "${input.placeId}".`, 404);
    }
    kind = place.kind;
    ref = place.id;
    name = place.name;
    lat = place.lat;
    lon = place.lon;
  } else {
    kind = "coordinate";
    ref = null;
    name = input.name?.trim() || "Egen position";
    // The schema refuses a body without both, so these are present here.
    lat = input.lat!;
    lon = input.lon!;
  }

  const now = new Date().toISOString();
  const sortOrder = selectNextOrder.get(userId)?.next ?? 0;
  const row = insertPlace.get(userId, input.label, kind, ref, name, lat, lon, sortOrder, now);
  if (!row) throw new AppError("not_saved", "Platsen kunde inte sparas.", 500);

  warmNeighbourhood(lat, lon, getSettings(userId));
  return toSavedPlace(row);
}

/**
 * Start computing the walking neighbourhood, and do not wait for it.
 *
 * It costs a handful of rate-limited routing calls and takes a few seconds, which is a
 * long time to hold a save open for. `getNeighbourhood` dedupes by centre, so the place
 * page's own request a moment later joins this computation instead of starting a second
 * one -- which is the point of starting it here rather than letting that request begin
 * from cold.
 */
function warmNeighbourhood(lat: number, lon: number, settings: CommuteSettings): void {
  void getNeighbourhood(lat, lon, settings).catch((err: unknown) => {
    // A failed warm-up is not a failed save: the place is stored, and the next read
    // tries again. It is logged because a run of these means routing is down.
    log.warn(`could not warm neighbourhood for ${lat},${lon}: ${describe(err)}`);
  });
}

export function updatePlace(
  userId: string,
  id: number,
  patch: SavedPlacePatch,
): SavedPlace | null {
  const row = updateLabel.get(
    userId,
    id,
    patch.label ?? null,
    patch.sortOrder ?? null,
    new Date().toISOString(),
  );
  return row ? toSavedPlace(row) : null;
}

/**
 * Deleting a place leaves its neighbourhood behind on purpose: it is keyed by
 * coordinate, shared with everyone else at that address, and expensive to recompute.
 */
export function deletePlace(userId: string, id: number): boolean {
  return deleteOne.get(userId, id) !== null;
}

// --- Settings ---------------------------------------------------------------

type SettingsRow = {
  speed_kmh: number;
  max_walk_minutes: number;
  transfer_penalty_minutes: number;
  walk_multiplier: number;
  catch_buffer_minutes: number;
};

const selectSettings = db.query<SettingsRow, [string]>(
  `SELECT speed_kmh, max_walk_minutes, transfer_penalty_minutes, walk_multiplier, catch_buffer_minutes
     FROM user_settings WHERE user_id = ?1`,
);
const upsertSettings = db.query(
  `INSERT INTO user_settings
     (user_id, speed_kmh, max_walk_minutes, transfer_penalty_minutes, walk_multiplier, catch_buffer_minutes, updated_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
   ON CONFLICT(user_id) DO UPDATE SET
     speed_kmh = excluded.speed_kmh,
     max_walk_minutes = excluded.max_walk_minutes,
     transfer_penalty_minutes = excluded.transfer_penalty_minutes,
     walk_multiplier = excluded.walk_multiplier,
     catch_buffer_minutes = excluded.catch_buffer_minutes,
     updated_at = excluded.updated_at`,
);

/** The schema's own defaults, so "no row yet" and "never changed" are the same answer. */
export const DEFAULT_SETTINGS: CommuteSettings = UserSettings.parse({});

export function getSettings(userId: string): CommuteSettings {
  const row = selectSettings.get(userId);
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    speedKmh: row.speed_kmh,
    maxWalkMinutes: row.max_walk_minutes,
    transferPenaltyMinutes: row.transfer_penalty_minutes,
    walkMultiplier: row.walk_multiplier,
    catchBufferMinutes: row.catch_buffer_minutes,
  };
}

export function putSettings(userId: string, patch: UserSettingsPatch): CommuteSettings {
  const next = mergeSettings(getSettings(userId), patch);
  upsertSettings.run(
    userId,
    next.speedKmh,
    next.maxWalkMinutes,
    next.transferPenaltyMinutes,
    next.walkMultiplier,
    next.catchBufferMinutes,
    new Date().toISOString(),
  );
  return next;
}

/**
 * Stored settings first, then whatever the caller actually said.
 *
 * Spelled out field by field rather than spread, because a spread of a partial parsed
 * from a query string carries `undefined` for every absent key and would overwrite the
 * stored value with it.
 */
export function mergeSettings(
  base: CommuteSettings,
  overrides: Partial<CommuteSettings>,
): CommuteSettings {
  return {
    speedKmh: overrides.speedKmh ?? base.speedKmh,
    maxWalkMinutes: overrides.maxWalkMinutes ?? base.maxWalkMinutes,
    transferPenaltyMinutes: overrides.transferPenaltyMinutes ?? base.transferPenaltyMinutes,
    walkMultiplier: overrides.walkMultiplier ?? base.walkMultiplier,
    catchBufferMinutes: overrides.catchBufferMinutes ?? base.catchBufferMinutes,
  };
}
