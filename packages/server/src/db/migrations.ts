/**
 * Forward-only migrations, applied in order inside one transaction and tracked with
 * `PRAGMA user_version`. Never edit a migration that has shipped; append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  // 1 -- catalog of everything SL publishes as a static list, plus sync bookkeeping.
  `
  CREATE TABLE sites (
    id              INTEGER PRIMARY KEY,
    gid             TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    note            TEXT,
    abbreviation    TEXT,
    alias           TEXT NOT NULL DEFAULT '[]',
    -- Four sites ship without coordinates but do have located platforms; these are
    -- nullable so those stops stay searchable, and are backfilled during sync.
    lat             REAL,
    lon             REAL,
    stop_areas      TEXT NOT NULL DEFAULT '[]',
    modes           TEXT NOT NULL DEFAULT '[]',
    valid_from      TEXT,
    valid_to        TEXT,
    content_hash    TEXT NOT NULL,
    first_seen_at   TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    removed_at      TEXT
  );
  CREATE INDEX sites_live_idx  ON sites(removed_at) WHERE removed_at IS NULL;
  CREATE INDEX sites_latlon_idx ON sites(lat, lon) WHERE removed_at IS NULL;

  CREATE TABLE stop_points (
    id                    INTEGER PRIMARY KEY,
    gid                   TEXT NOT NULL UNIQUE,
    name                  TEXT NOT NULL,
    short_name            TEXT,
    designation           TEXT,
    type                  TEXT,
    lat                   REAL,
    lon                   REAL,
    stop_area_id          INTEGER,
    stop_area_name        TEXT,
    stop_area_type        TEXT,
    has_entrance          INTEGER NOT NULL DEFAULT 0,
    content_hash          TEXT NOT NULL,
    first_seen_at         TEXT NOT NULL,
    last_seen_at          TEXT NOT NULL,
    removed_at            TEXT
  );
  CREATE INDEX stop_points_area_idx ON stop_points(stop_area_id) WHERE removed_at IS NULL;

  CREATE TABLE lines (
    id                      INTEGER NOT NULL,
    transport_authority_id  INTEGER NOT NULL,
    gid                     TEXT NOT NULL,
    name                    TEXT,
    designation             TEXT NOT NULL,
    mode                    TEXT NOT NULL,
    group_of_lines          TEXT,
    contractor              TEXT,
    valid_from              TEXT,
    valid_to                TEXT,
    content_hash            TEXT NOT NULL,
    first_seen_at           TEXT NOT NULL,
    last_seen_at            TEXT NOT NULL,
    removed_at              TEXT,
    PRIMARY KEY (id, transport_authority_id)
  );
  CREATE INDEX lines_designation_idx ON lines(designation) WHERE removed_at IS NULL;

  CREATE TABLE transport_authorities (
    id            INTEGER PRIMARY KEY,
    gid           TEXT NOT NULL,
    name          TEXT NOT NULL,
    formal_name   TEXT,
    code          TEXT,
    content_hash  TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    removed_at    TEXT
  );

  CREATE TABLE sync_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity      TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL,
    added       INTEGER NOT NULL DEFAULT 0,
    updated     INTEGER NOT NULL DEFAULT 0,
    removed     INTEGER NOT NULL DEFAULT 0,
    error       TEXT
  );
  CREATE INDEX sync_runs_entity_idx ON sync_runs(entity, started_at DESC);
  `,

  // 2 -- full-text search over the site catalog.
  //      Diacritics are folded so "sodermalm" finds "Södermalm", which is how anyone
  //      actually types on a phone.
  `
  CREATE VIRTUAL TABLE sites_fts USING fts5(
    name,
    alias,
    note,
    abbreviation,
    tokenize = "unicode61 remove_diacritics 2"
  );
  `,

  // 3 -- short-lived response cache for upstream calls we must not hammer.
  `
  CREATE TABLE http_cache (
    key         TEXT PRIMARY KEY,
    body        TEXT NOT NULL,
    stored_at   TEXT NOT NULL,
    expires_at  TEXT NOT NULL
  );
  CREATE INDEX http_cache_expiry_idx ON http_cache(expires_at);
  `,

  // 4 -- the user's own data. Local-first: this is the part that is not re-derivable
  //      from SL, so it is the part that has to survive a volume restore.
  `
  CREATE TABLE saved_places (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    name        TEXT NOT NULL,
    locality    TEXT,
    lat         REAL NOT NULL,
    lon         REAL NOT NULL,
    site_id     INTEGER,
    modes       TEXT NOT NULL DEFAULT '[]',
    label       TEXT,
    pinned      INTEGER NOT NULL DEFAULT 0,
    use_count   INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX saved_places_recent_idx ON saved_places(pinned DESC, last_used_at DESC);

  CREATE TABLE saved_journeys (
    id            TEXT PRIMARY KEY,
    from_place_id TEXT NOT NULL,
    from_name     TEXT NOT NULL,
    to_place_id   TEXT NOT NULL,
    to_name       TEXT NOT NULL,
    label         TEXT,
    pinned        INTEGER NOT NULL DEFAULT 0,
    use_count     INTEGER NOT NULL DEFAULT 0,
    last_used_at  TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX saved_journeys_recent_idx ON saved_journeys(pinned DESC, last_used_at DESC);
  `,
];
