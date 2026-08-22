import { Hono, type Context } from "hono";
import { z } from "zod";
import { Place } from "@traveler/shared";
import { db } from "../db/index.ts";
import { AppError } from "../lib/errors.ts";

export const saved = new Hono();

/**
 * Favourites and recents.
 *
 * This is the only data in the system that is not re-derivable from SL, which makes it
 * the only data that genuinely needs the persistent volume. Everything else is a cache.
 */

const SavePlaceBody = z.object({
  place: Place,
  label: z.string().trim().max(60).nullable().default(null),
  pinned: z.boolean().default(false),
});

const SaveJourneyBody = z.object({
  from: Place,
  to: Place,
  label: z.string().trim().max(60).nullable().default(null),
  pinned: z.boolean().default(false),
});

async function body<S extends z.ZodType>(schema: S, c: Context): Promise<z.infer<S>> {
  const raw = await c.req.json().catch(() => null);
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new AppError("invalid_body", result.error.issues[0]?.message ?? "Invalid body", 400, result.error.issues);
  }
  return result.data as z.infer<S>;
}

const listPlaces = db.query(
  `SELECT id, kind, name, locality, lat, lon, site_id, modes, label, pinned, use_count, last_used_at
     FROM saved_places ORDER BY pinned DESC, last_used_at DESC, use_count DESC LIMIT 100`,
);

type SavedPlaceRow = {
  id: string;
  kind: string;
  name: string;
  locality: string | null;
  lat: number;
  lon: number;
  site_id: number | null;
  modes: string;
  label: string | null;
  pinned: number;
  use_count: number;
  last_used_at: string | null;
};

function toSavedPlace(row: SavedPlaceRow) {
  return {
    place: {
      id: row.id,
      kind: row.kind,
      name: row.name,
      locality: row.locality,
      lat: row.lat,
      lon: row.lon,
      modes: JSON.parse(row.modes) as string[],
      siteId: row.site_id,
      cached: true,
      distanceMetres: null,
    },
    label: row.label,
    pinned: row.pinned === 1,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
  };
}

saved.get("/places", (c) =>
  c.json({ places: (listPlaces.all() as SavedPlaceRow[]).map(toSavedPlace) }),
);

const upsertPlace = db.query(
  `INSERT INTO saved_places (id, kind, name, locality, lat, lon, site_id, modes, label, pinned, use_count, last_used_at, created_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?11)
   ON CONFLICT(id) DO UPDATE SET
     name = excluded.name, locality = excluded.locality, lat = excluded.lat, lon = excluded.lon,
     site_id = excluded.site_id, modes = excluded.modes,
     label = COALESCE(excluded.label, saved_places.label),
     pinned = excluded.pinned,
     use_count = saved_places.use_count + 1,
     last_used_at = excluded.last_used_at`,
);

saved.post("/places", async (c) => {
  const { place, label, pinned } = await body(SavePlaceBody, c);
  const now = new Date().toISOString();
  upsertPlace.run(
    place.id,
    place.kind,
    place.name,
    place.locality,
    place.lat,
    place.lon,
    place.siteId,
    JSON.stringify(place.modes),
    label,
    pinned ? 1 : 0,
    now,
  );
  return c.json({ ok: true }, 201);
});

saved.delete("/places", (c) => {
  const id = c.req.query("id");
  if (!id) throw new AppError("missing_id", "Pass the place id as ?id=", 400);
  const { changes } = db.query(`DELETE FROM saved_places WHERE id = ?1`).run(id);
  return c.json({ deleted: changes });
});

const listJourneys = db.query(
  `SELECT id, from_place_id, from_name, to_place_id, to_name, label, pinned, use_count, last_used_at
     FROM saved_journeys ORDER BY pinned DESC, last_used_at DESC, use_count DESC LIMIT 100`,
);

saved.get("/journeys", (c) => c.json({ journeys: listJourneys.all() }));

const upsertJourney = db.query(
  `INSERT INTO saved_journeys (id, from_place_id, from_name, to_place_id, to_name, label, pinned, use_count, last_used_at, created_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)
   ON CONFLICT(id) DO UPDATE SET
     from_name = excluded.from_name, to_name = excluded.to_name,
     label = COALESCE(excluded.label, saved_journeys.label),
     pinned = excluded.pinned,
     use_count = saved_journeys.use_count + 1,
     last_used_at = excluded.last_used_at`,
);

saved.post("/journeys", async (c) => {
  const { from, to, label, pinned } = await body(SaveJourneyBody, c);
  const now = new Date().toISOString();
  // Deterministic id so re-planning the same trip bumps its counter instead of piling
  // up near-identical rows in the recents list.
  const id = Bun.hash(`${from.id}->${to.id}`).toString(36);
  upsertJourney.run(id, from.id, from.name, to.id, to.name, label, pinned ? 1 : 0, now);
  return c.json({ ok: true, id }, 201);
});

saved.delete("/journeys", (c) => {
  const id = c.req.query("id");
  if (!id) throw new AppError("missing_id", "Pass the journey id as ?id=", 400);
  const { changes } = db.query(`DELETE FROM saved_journeys WHERE id = ?1`).run(id);
  return c.json({ deleted: changes });
});
