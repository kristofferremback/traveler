import type { Place, TransportMode } from "@traveler/shared";
import { db } from "./index.ts";
import { degreeBox, haversineMetres } from "../lib/geo.ts";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type SiteRow = {
  id: number;
  gid: string;
  name: string;
  note: string | null;
  abbreviation: string | null;
  alias: string;
  lat: number;
  lon: number;
  stop_areas: string;
  modes: string;
};

function parseModes(json: string): TransportMode[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as TransportMode[]) : [];
  } catch {
    return [];
  }
}

export function rowToPlace(row: SiteRow, distanceMetres: number | null = null): Place {
  return {
    // The journey planner addresses stops by their global id, which is exactly `gid`.
    // Handing back the numeric site id here would produce a plausible-looking id that
    // silently returns no journeys.
    id: row.gid,
    kind: "stop",
    name: row.name,
    locality: row.note,
    lat: row.lat,
    lon: row.lon,
    modes: parseModes(row.modes),
    siteId: row.id,
    cached: true,
    distanceMetres,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const SITE_COLUMNS = `id, gid, name, note, abbreviation, alias, lat, lon, stop_areas, modes`;

const siteById = db.query<SiteRow, [number]>(
  `SELECT ${SITE_COLUMNS} FROM sites WHERE id = ?1 AND removed_at IS NULL`,
);
const siteByGid = db.query<SiteRow, [string]>(
  `SELECT ${SITE_COLUMNS} FROM sites WHERE gid = ?1 AND removed_at IS NULL`,
);

export function getSite(id: number): SiteRow | null {
  return siteById.get(id) ?? null;
}

export function getSiteByGid(gid: string): SiteRow | null {
  return siteByGid.get(gid) ?? null;
}

/**
 * FTS5 treats most punctuation as syntax. A stop called "Kungsgatan / Vasagatan" typed
 * back verbatim is a query error, not zero results, so the input is reduced to bare
 * tokens and the last one gets a prefix wildcard for as-you-type matching.
 */
function toMatchQuery(input: string): string | null {
  const tokens = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`)).join(" AND ");
}

const searchSites = db.query<SiteRow & { rank: number }, [string, number]>(
  `SELECT s.id, s.gid, s.name, s.note, s.abbreviation, s.alias, s.lat, s.lon,
          s.stop_areas, s.modes, f.rank AS rank
     FROM sites_fts f
     JOIN sites s ON s.id = f.rowid
    WHERE sites_fts MATCH ?1
      AND s.removed_at IS NULL
    ORDER BY f.rank
    LIMIT ?2`,
);

export function searchStops(
  query: string,
  limit: number,
  origin?: { lat: number; lon: number },
): Place[] {
  const match = toMatchQuery(query);
  if (!match) return [];

  // Over-fetch so that distance re-ranking has something to reorder; FTS rank alone
  // puts "Centralen" in Norrtälje above the one you are standing in.
  const rows = searchSites.all(match, origin ? limit * 4 : limit);

  const places = rows.map((row) =>
    rowToPlace(
      row,
      origin ? Math.round(haversineMetres(origin.lat, origin.lon, row.lat, row.lon)) : null,
    ),
  );

  if (origin) {
    places.sort((a, b) => (a.distanceMetres ?? 0) - (b.distanceMetres ?? 0));
  }
  return places.slice(0, limit);
}

const sitesInBox = db.query<SiteRow, [number, number, number, number]>(
  `SELECT ${SITE_COLUMNS} FROM sites
    WHERE removed_at IS NULL
      AND lat BETWEEN ?1 AND ?2
      AND lon BETWEEN ?3 AND ?4`,
);

export function nearbyStops(
  lat: number,
  lon: number,
  radiusMetres: number,
  limit: number,
  modes?: TransportMode[],
): Place[] {
  // Cheap indexed bounding box first, exact haversine second. The box is a superset of
  // the circle, so nothing inside the radius is lost.
  const box = degreeBox(lat, lon, radiusMetres);
  const wanted = modes?.length ? new Set(modes) : null;

  const out: Place[] = [];
  for (const row of sitesInBox.all(box.minLat, box.maxLat, box.minLon, box.maxLon)) {
    const distance = haversineMetres(lat, lon, row.lat, row.lon);
    if (distance > radiusMetres) continue;
    const place = rowToPlace(row, Math.round(distance));
    if (wanted && !place.modes.some((m) => wanted.has(m))) continue;
    out.push(place);
  }
  out.sort((a, b) => (a.distanceMetres ?? 0) - (b.distanceMetres ?? 0));
  return out.slice(0, limit);
}

/**
 * Nearest catalogued stop to a coordinate, used to give journey-leg stops a tappable
 * departures board. The tolerance is deliberately tight: the journey planner reports
 * platform coordinates, so a real match is metres away, and a loose radius would
 * attach the wrong station in a dense interchange.
 */
export function siteNearCoordinate(
  lat: number,
  lon: number,
  toleranceMetres = 150,
): SiteRow | null {
  const box = degreeBox(lat, lon, toleranceMetres);
  let best: SiteRow | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of sitesInBox.all(box.minLat, box.maxLat, box.minLon, box.maxLon)) {
    const distance = haversineMetres(lat, lon, row.lat, row.lon);
    if (distance < bestDistance && distance <= toleranceMetres) {
      best = row;
      bestDistance = distance;
    }
  }
  return best;
}

const countLive = (table: string) =>
  db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table} WHERE removed_at IS NULL`);

const siteCount = countLive("sites");
const stopPointCount = countLive("stop_points");
const lineCount = countLive("lines");

const ftsSize = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sites_fts");

/**
 * Rows in the search index.
 *
 * Counted separately from `sites` because the two are populated in different steps of
 * a sync. Between them the catalog holds every stop and search returns nothing, which
 * looks exactly like a broken deployment.
 */
export function searchIndexSize(): number {
  return ftsSize.get()?.n ?? 0;
}

export function catalogCounts() {
  return {
    sites: siteCount.get()?.n ?? 0,
    stopPoints: stopPointCount.get()?.n ?? 0,
    lines: lineCount.get()?.n ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Stop points
// ---------------------------------------------------------------------------

export type StopPointRow = {
  id: number;
  name: string;
  lat: number;
  lon: number;
  stop_area_id: number | null;
  stop_area_type: string | null;
  site_id: number;
  site_gid: string;
  site_name: string;
};

const stopPointsInBox = db.query<
  {
    id: number;
    name: string;
    lat: number;
    lon: number;
    stop_area_id: number | null;
    stop_area_type: string | null;
  },
  [number, number, number, number]
>(
  `SELECT id, name, lat, lon, stop_area_id, stop_area_type FROM stop_points
    WHERE removed_at IS NULL AND lat IS NOT NULL AND lon IS NOT NULL
      AND lat BETWEEN ?1 AND ?2 AND lon BETWEEN ?3 AND ?4`,
);

const siteByStopArea = db.query<{ stop_area_id: number; id: number; gid: string; name: string }, []>(
  `SELECT j.value AS stop_area_id, s.id, s.gid, s.name
     FROM sites s, json_each(s.stop_areas) j
    WHERE s.removed_at IS NULL`,
);

/**
 * Stop points near a coordinate, each joined to the site it belongs to.
 *
 * SL publishes the join the other way round -- a site lists its stop areas -- so the
 * area→site map is built in one pass here rather than with a per-row json_each, which
 * would make the query quadratic.
 */
export function stopPointsNear(lat: number, lon: number, radiusMetres: number): (StopPointRow & { distanceMetres: number })[] {
  const box = degreeBox(lat, lon, radiusMetres);
  const areaToSite = new Map<number, { id: number; gid: string; name: string }>();
  for (const row of siteByStopArea.all()) {
    areaToSite.set(row.stop_area_id, { id: row.id, gid: row.gid, name: row.name });
  }

  const out: (StopPointRow & { distanceMetres: number })[] = [];
  for (const p of stopPointsInBox.all(box.minLat, box.maxLat, box.minLon, box.maxLon)) {
    const distance = haversineMetres(lat, lon, p.lat, p.lon);
    if (distance > radiusMetres) continue;
    const site = p.stop_area_id === null ? undefined : areaToSite.get(p.stop_area_id);
    // A stop point with no site cannot be asked for trips or departures; skip it
    // rather than produce a stop you can walk to but never leave from.
    if (!site) continue;
    out.push({
      ...p,
      site_id: site.id,
      site_gid: site.gid,
      site_name: site.name,
      distanceMetres: Math.round(distance),
    });
  }
  out.sort((a, b) => a.distanceMetres - b.distanceMetres);
  return out;
}
