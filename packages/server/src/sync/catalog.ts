import { db } from "../db/index.ts";
import { logger } from "../lib/log.ts";
import { describe } from "../lib/errors.ts";
import { normaliseMode, modeFromStopAreaType } from "../sl/modes.ts";
import {
  fetchLines,
  fetchSites,
  fetchStopPoints,
  fetchTransportAuthorities,
  type SlLine,
  type SlSite,
  type SlStopPoint,
} from "../sl/transport.ts";

const log = logger("sync");

export type SyncCounts = { added: number; updated: number; removed: number };
export type SyncOutcome = SyncCounts & { entity: string; durationMs: number };

/**
 * Content hash of the fields we store. Cheap and non-cryptographic on purpose -- this
 * only has to answer "did anything I care about change", 20k times a day.
 */
function hash(parts: unknown[]): string {
  return Bun.hash(JSON.stringify(parts)).toString(36);
}

const beginRun = db.query<{ id: number }, [string, string]>(
  `INSERT INTO sync_runs (entity, started_at, status) VALUES (?1, ?2, 'running') RETURNING id`,
);
const finishRun = db.query(
  `UPDATE sync_runs SET finished_at = ?2, status = ?3, added = ?4, updated = ?5, removed = ?6, error = ?7
     WHERE id = ?1`,
);

/**
 * Rows are soft-deleted rather than removed.
 *
 * A saved journey or a shared link can reference a stop that SL retires; keeping the
 * row means that link degrades to "this stop is gone" instead of a foreign key
 * violation or, worse, a silently empty page.
 */
function retireMissing(
  table: string,
  seen: Set<string | number>,
  now: string,
  /** Restricts retirement to rows this run actually had authority to speak for. */
  inScope: (key: string | number) => boolean = () => true,
): number {
  const live = db
    .query<{ key: string | number }, []>(
      `SELECT ${table === "lines" ? "id || ':' || transport_authority_id" : "id"} AS key
         FROM ${table} WHERE removed_at IS NULL`,
    )
    .all();

  const gone = live.filter((row) => inScope(row.key) && !seen.has(row.key));
  if (gone.length === 0) return 0;

  if (table === "lines") {
    const stmt = db.query(
      `UPDATE lines SET removed_at = ?1 WHERE id = ?2 AND transport_authority_id = ?3`,
    );
    for (const row of gone) {
      const [id, ta] = String(row.key).split(":");
      stmt.run(now, Number(id), Number(ta));
    }
  } else {
    const stmt = db.query(`UPDATE ${table} SET removed_at = ?2 WHERE id = ?1`);
    for (const row of gone) stmt.run(row.key, now);
  }
  return gone.length;
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

function upsertSites(sites: SlSite[], now: string): SyncCounts {
  const existing = new Map(
    db
      .query<{ id: number; content_hash: string; removed_at: string | null }, []>(
        `SELECT id, content_hash, removed_at FROM sites`,
      )
      .all()
      .map((r) => [r.id, r]),
  );

  const insert = db.query(
    `INSERT INTO sites (id, gid, name, note, abbreviation, alias, lat, lon, stop_areas, modes,
                        valid_from, valid_to, content_hash, first_seen_at, last_seen_at, removed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '[]', ?10, ?11, ?12, ?13, ?13, NULL)
     ON CONFLICT(id) DO UPDATE SET
       gid = excluded.gid, name = excluded.name, note = excluded.note,
       abbreviation = excluded.abbreviation, alias = excluded.alias,
       lat = excluded.lat, lon = excluded.lon, stop_areas = excluded.stop_areas,
       valid_from = excluded.valid_from, valid_to = excluded.valid_to,
       content_hash = excluded.content_hash, last_seen_at = excluded.last_seen_at,
       removed_at = NULL`,
  );
  const touch = db.query(
    `UPDATE sites SET last_seen_at = ?2, removed_at = NULL WHERE id = ?1`,
  );

  let added = 0;
  let updated = 0;
  const seen = new Set<number>();

  for (const site of sites) {
    seen.add(site.id);
    const alias = JSON.stringify(site.alias ?? []);
    const stopAreas = JSON.stringify(site.stop_areas ?? []);
    const contentHash = hash([
      site.gid,
      site.name,
      site.note ?? null,
      site.abbreviation ?? null,
      alias,
      site.lat ?? null,
      site.lon ?? null,
      stopAreas,
      site.valid?.from ?? null,
      site.valid?.upto ?? null,
    ]);

    const prior = existing.get(site.id);
    if (prior && prior.content_hash === contentHash && !prior.removed_at) {
      touch.run(site.id, now);
      continue;
    }

    insert.run(
      site.id,
      site.gid,
      site.name,
      site.note ?? null,
      site.abbreviation ?? null,
      alias,
      site.lat ?? null,
      site.lon ?? null,
      stopAreas,
      site.valid?.from ?? null,
      site.valid?.upto ?? null,
      contentHash,
      now,
    );
    if (prior) updated++;
    else added++;
  }

  const removed = retireMissing("sites", seen, now);
  return { added, updated, removed };
}

// ---------------------------------------------------------------------------
// Stop points
// ---------------------------------------------------------------------------

function upsertStopPoints(points: SlStopPoint[], now: string): SyncCounts {
  const existing = new Map(
    db
      .query<{ id: number; content_hash: string; removed_at: string | null }, []>(
        `SELECT id, content_hash, removed_at FROM stop_points`,
      )
      .all()
      .map((r) => [r.id, r]),
  );

  const insert = db.query(
    `INSERT INTO stop_points (id, gid, name, short_name, designation, type, lat, lon,
                              stop_area_id, stop_area_name, stop_area_type, has_entrance,
                              content_hash, first_seen_at, last_seen_at, removed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, NULL)
     ON CONFLICT(id) DO UPDATE SET
       gid = excluded.gid, name = excluded.name, short_name = excluded.short_name,
       designation = excluded.designation, type = excluded.type,
       lat = excluded.lat, lon = excluded.lon,
       stop_area_id = excluded.stop_area_id, stop_area_name = excluded.stop_area_name,
       stop_area_type = excluded.stop_area_type, has_entrance = excluded.has_entrance,
       content_hash = excluded.content_hash, last_seen_at = excluded.last_seen_at,
       removed_at = NULL`,
  );
  const touch = db.query(
    `UPDATE stop_points SET last_seen_at = ?2, removed_at = NULL WHERE id = ?1`,
  );

  let added = 0;
  let updated = 0;
  const seen = new Set<number>();

  for (const point of points) {
    seen.add(point.id);
    const contentHash = hash([
      point.gid,
      point.name,
      point.sname ?? null,
      point.designation ?? null,
      point.type ?? null,
      point.lat ?? null,
      point.lon ?? null,
      point.stop_area?.id ?? null,
      point.stop_area?.type ?? null,
    ]);

    const prior = existing.get(point.id);
    if (prior && prior.content_hash === contentHash && !prior.removed_at) {
      touch.run(point.id, now);
      continue;
    }

    insert.run(
      point.id,
      point.gid,
      point.name,
      point.sname ?? null,
      point.designation ?? null,
      point.type ?? null,
      point.lat ?? null,
      point.lon ?? null,
      point.stop_area?.id ?? null,
      point.stop_area?.name ?? null,
      point.stop_area?.type ?? null,
      point.has_entrance ? 1 : 0,
      contentHash,
      now,
    );
    if (prior) updated++;
    else added++;
  }

  const removed = retireMissing("stop_points", seen, now);
  return { added, updated, removed };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/**
 * `fetchedAuthorities` is the set of authorities whose line list was actually retrieved
 * this run.
 *
 * Retirement is scoped to it because a single authority timing out would otherwise look
 * identical to that authority deleting every one of its lines. Waxholmsbolaget alone
 * runs 39 boat routes; one failed request would have quietly emptied the archipelago.
 */
function upsertLines(
  lines: SlLine[],
  now: string,
  fetchedAuthorities: Set<number>,
): SyncCounts {
  const existing = new Map(
    db
      .query<
        { key: string; content_hash: string; removed_at: string | null },
        []
      >(
        `SELECT id || ':' || transport_authority_id AS key, content_hash, removed_at FROM lines`,
      )
      .all()
      .map((r) => [r.key, r]),
  );

  const insert = db.query(
    `INSERT INTO lines (id, transport_authority_id, gid, name, designation, mode,
                        group_of_lines, contractor, valid_from, valid_to,
                        content_hash, first_seen_at, last_seen_at, removed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, NULL)
     ON CONFLICT(id, transport_authority_id) DO UPDATE SET
       gid = excluded.gid, name = excluded.name, designation = excluded.designation,
       mode = excluded.mode, group_of_lines = excluded.group_of_lines,
       contractor = excluded.contractor, valid_from = excluded.valid_from,
       valid_to = excluded.valid_to, content_hash = excluded.content_hash,
       last_seen_at = excluded.last_seen_at, removed_at = NULL`,
  );
  const touch = db.query(
    `UPDATE lines SET last_seen_at = ?3, removed_at = NULL
       WHERE id = ?1 AND transport_authority_id = ?2`,
  );

  let added = 0;
  let updated = 0;
  const seen = new Set<string>();

  for (const line of lines) {
    const ta = line.transport_authority?.id ?? 0;
    const key = `${line.id}:${ta}`;
    if (seen.has(key)) continue; // SL repeats a line across mode groups occasionally.
    seen.add(key);

    const contentHash = hash([
      line.gid,
      line.name ?? null,
      line.designation,
      line.transport_mode,
      line.group_of_lines ?? null,
      line.contractor?.name ?? null,
      line.valid?.from ?? null,
      line.valid?.upto ?? null,
    ]);

    const prior = existing.get(key);
    if (prior && prior.content_hash === contentHash && !prior.removed_at) {
      touch.run(line.id, ta, now);
      continue;
    }

    insert.run(
      line.id,
      ta,
      line.gid,
      line.name ?? null,
      line.designation,
      normaliseMode(line.transport_mode),
      line.group_of_lines ?? null,
      line.contractor?.name ?? null,
      line.valid?.from ?? null,
      line.valid?.upto ?? null,
      contentHash,
      now,
    );
    if (prior) updated++;
    else added++;
  }

  const removed = retireMissing("lines", seen, now, (key) => {
    const authority = Number(String(key).split(":")[1]);
    return fetchedAuthorities.has(authority);
  });
  return { added, updated, removed };
}

// ---------------------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------------------

/**
 * A handful of sites arrive without coordinates while their stop points are located
 * precisely. Averaging the platforms puts the site on the map roughly where a traveller
 * would point at it, which beats hiding a real stop from search and nearby results.
 */
function backfillSiteCoordinates(): number {
  const rows = db
    .query<{ id: number; avg_lat: number | null; avg_lon: number | null }, []>(
      `SELECT s.id AS id, AVG(p.lat) AS avg_lat, AVG(p.lon) AS avg_lon
         FROM sites s
         JOIN json_each(s.stop_areas) a
         JOIN stop_points p ON p.stop_area_id = a.value AND p.removed_at IS NULL
        WHERE s.removed_at IS NULL AND (s.lat IS NULL OR s.lon IS NULL)
        GROUP BY s.id
       HAVING avg_lat IS NOT NULL AND avg_lon IS NOT NULL`,
    )
    .all();

  const update = db.query(`UPDATE sites SET lat = ?2, lon = ?3 WHERE id = ?1`);
  for (const row of rows) update.run(row.id, row.avg_lat, row.avg_lon);
  if (rows.length > 0) log.info(`backfilled coordinates for ${rows.length} sites`);
  return rows.length;
}

/**
 * A site's modes are not published anywhere. They are inferred from the stop-area type
 * of the stop points that belong to it -- BUSTERM means a bus stops there, METROSTN
 * means the metro does. Without this the UI cannot show mode icons or filter "boats
 * near me", which is most of why a local catalog is worth keeping.
 */
function deriveSiteModes(): number {
  const rows = db
    .query<{ id: number; stop_areas: string }, []>(
      `SELECT id, stop_areas FROM sites WHERE removed_at IS NULL`,
    )
    .all();

  const areaTypes = new Map<number, string>();
  for (const point of db
    .query<{ stop_area_id: number | null; stop_area_type: string | null }, []>(
      `SELECT DISTINCT stop_area_id, stop_area_type FROM stop_points WHERE removed_at IS NULL`,
    )
    .all()) {
    if (point.stop_area_id !== null && point.stop_area_type) {
      areaTypes.set(point.stop_area_id, point.stop_area_type);
    }
  }

  const update = db.query(`UPDATE sites SET modes = ?2 WHERE id = ?1`);
  let changed = 0;
  for (const row of rows) {
    let areas: number[] = [];
    try {
      areas = JSON.parse(row.stop_areas) as number[];
    } catch {
      areas = [];
    }
    const modes = [
      ...new Set(
        areas
          .map((a) => modeFromStopAreaType(areaTypes.get(a)))
          .filter((m) => m !== "UNKNOWN"),
      ),
    ].sort();
    update.run(row.id, JSON.stringify(modes));
    changed++;
  }
  return changed;
}

/**
 * FTS5 is rebuilt wholesale rather than kept in sync with triggers. At 6.5k rows this
 * takes milliseconds, and it removes an entire class of "the index disagrees with the
 * table" bug that triggers invite.
 */
function rebuildSearchIndex(): number {
  db.exec("DELETE FROM sites_fts");
  const insert = db.query(
    `INSERT INTO sites_fts (rowid, name, alias, note, abbreviation) VALUES (?1, ?2, ?3, ?4, ?5)`,
  );
  // `id AS site_id` rather than a bare `rowid`: bun:sqlite drops the implicit rowid
  // column from result objects, and an undefined rowid makes FTS5 auto-assign a
  // sequential one. The index then joins cleanly onto entirely the wrong stops --
  // searching "Slussen" returned "Gräddö torg" until this was aliased.
  const rows = db
    .query<
      {
        site_id: number;
        name: string;
        alias: string;
        note: string | null;
        abbreviation: string | null;
      },
      []
    >(
      `SELECT id AS site_id, name, alias, note, abbreviation
         FROM sites WHERE removed_at IS NULL`,
    )
    .all();

  for (const row of rows) {
    let alias: string[] = [];
    try {
      alias = JSON.parse(row.alias) as string[];
    } catch {
      alias = [];
    }
    insert.run(row.site_id, row.name, alias.join(" "), row.note ?? "", row.abbreviation ?? "");
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runStep(
  entity: string,
  work: (now: string) => Promise<SyncCounts> | SyncCounts,
): Promise<SyncOutcome> {
  const started = Date.now();
  const now = new Date().toISOString();
  const runId = beginRun.get(entity, now)!.id;
  try {
    const counts = await work(now);
    finishRun.run(
      runId,
      new Date().toISOString(),
      "ok",
      counts.added,
      counts.updated,
      counts.removed,
      null,
    );
    const outcome = { entity, ...counts, durationMs: Date.now() - started };
    log.info(
      `${entity}: +${counts.added} ~${counts.updated} -${counts.removed} in ${outcome.durationMs}ms`,
    );
    return outcome;
  } catch (err) {
    finishRun.run(runId, new Date().toISOString(), "failed", 0, 0, 0, describe(err));
    throw err;
  }
}

/**
 * One full catalog pass.
 *
 * Each entity is fetched over the network first and only then written, inside its own
 * transaction. A network failure therefore leaves the previous catalog completely
 * intact rather than half-replaced -- the app keeps working on yesterday's data, which
 * for a stop list is almost as good as today's.
 */
export async function syncCatalog(): Promise<SyncOutcome[]> {
  const outcomes: SyncOutcome[] = [];

  const sites = await fetchSites();
  outcomes.push(
    await runStep("sites", (now) => db.transaction(() => upsertSites(sites, now))()),
  );

  const stopPoints = await fetchStopPoints();
  outcomes.push(
    await runStep("stop_points", (now) =>
      db.transaction(() => upsertStopPoints(stopPoints, now))(),
    ),
  );

  const authorities = await fetchTransportAuthorities();
  const allLines: SlLine[] = [];
  const fetchedAuthorities = new Set<number>();
  for (const authority of authorities) {
    try {
      allLines.push(...(await fetchLines(authority.id)));
      fetchedAuthorities.add(authority.id);
    } catch (err) {
      // One authority refusing should not cost us the other thirteen, and must not
      // cost that authority its lines either -- see upsertLines.
      log.warn(`lines for authority ${authority.id} failed: ${describe(err)}`);
    }
  }
  if (fetchedAuthorities.size < authorities.length) {
    log.warn(
      `line retirement limited to ${fetchedAuthorities.size}/${authorities.length} authorities this run`,
    );
  }
  outcomes.push(
    await runStep("lines", (now) =>
      db.transaction(() => upsertLines(allLines, now, fetchedAuthorities))(),
    ),
  );

  outcomes.push(
    await runStep("derived", () =>
      db.transaction(() => {
        backfillSiteCoordinates();
        deriveSiteModes();
        const indexed = rebuildSearchIndex();
        return { added: 0, updated: indexed, removed: 0 };
      })(),
    ),
  );

  return outcomes;
}

export function lastSync(entity = "sites") {
  return (
    db
      .query<
        {
          started_at: string;
          finished_at: string | null;
          status: string;
          added: number;
          updated: number;
          removed: number;
          error: string | null;
        },
        [string]
      >(
        `SELECT started_at, finished_at, status, added, updated, removed, error
           FROM sync_runs WHERE entity = ?1 AND status != 'running'
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(entity) ?? null
  );
}
