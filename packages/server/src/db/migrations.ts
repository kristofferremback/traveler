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

  // 5 -- drop the saved-place tables added in 4.
  //
  //      They were built ahead of any feature that needed them and were served by a
  //      public, unauthenticated API: anyone who found the URL could read, overwrite or
  //      endlessly append personal places on a deployed instance. There is no
  //      authentication in this build, so the storage goes too rather than sitting
  //      there as an attractive nuisance.
  //
  //      Migration 4 is left untouched rather than rewritten. Forward-only is the whole
  //      point: a database that already applied it gets the tables removed here, which
  //      editing history in place would not achieve.
  //
  //      When favourites are built for real, they need a new migration and an owner for
  //      the rows -- a session, an account, something -- decided before the schema.
  `
  DROP INDEX IF EXISTS saved_places_recent_idx;
  DROP TABLE IF EXISTS saved_places;
  DROP INDEX IF EXISTS saved_journeys_recent_idx;
  DROP TABLE IF EXISTS saved_journeys;
  `,

  // 6 -- computed walking neighbourhoods.
  //
  //      Derived data, not personal data: the street facts (metres, climb, shape) from a
  //      coordinate to every stop point within walking range, as routed by Valhalla.
  //      Keyed by the rounded coordinate so two people at the same address share one
  //      computation, and so a place can be deleted without losing the work. Anything
  //      that depends on the walker (minutes, which stops are "in range") is derived at
  //      read time from their settings.
  `
  CREATE TABLE neighbourhoods (
    centre_key   TEXT PRIMARY KEY,
    lat          REAL NOT NULL,
    lon          REAL NOT NULL,
    body         TEXT NOT NULL,
    computed_at  TEXT NOT NULL
  );
  `,

  // 7 -- accounts, so rows can have an owner.
  //
  //      The quoted block is generated by better-auth 1.7.1 for the core schema plus the
  //      passkey and api-key plugins, and is owned here rather than by the library's own
  //      migrator: this database has one migration ladder, tracked by PRAGMA
  //      user_version, and two of them racing on the same file is how you get a half
  //      applied schema. `auth/__tests__/schema.test.ts` asks better-auth what it expects
  //      and fails if this drifts from it, so upgrading a plugin means a new migration
  //      here, never an edit to this one.
  //
  //      Quoted identifiers and camelCase columns look foreign next to the rest of this
  //      file. They are the library's names and changing them means maintaining a field
  //      mapping forever, so they stay as generated.
  //
  //      `invites` is ours. Better Auth's magic-link plugin hands the link to a "send"
  //      callback and keeps only an opaque verification row, so there is nowhere to read
  //      an invite back from -- no way to show the link again, or to see who invited
  //      whom. This table is that record. The token itself lives in `verification` and
  //      is what decides whether the link still works; this is the audit trail beside it.
  `
  create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);
  create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);
  create table "account" ("id" text not null primary key, "issuer" text not null, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
  create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
  create table "passkey" ("id" text not null primary key, "name" text, "publicKey" text not null, "userId" text not null references "user" ("id") on delete cascade, "credentialID" text not null, "counter" integer not null, "deviceType" text not null, "backedUp" integer not null, "transports" text, "createdAt" date, "aaguid" text);
  create table "apikey" ("id" text not null primary key, "configId" text not null, "name" text, "start" text, "referenceId" text not null, "prefix" text, "key" text not null, "refillInterval" integer, "refillAmount" integer, "lastRefillAt" date, "enabled" integer, "rateLimitEnabled" integer, "rateLimitTimeWindow" integer, "rateLimitMax" integer, "requestCount" integer, "remaining" integer, "lastRequest" date, "expiresAt" date, "createdAt" date not null, "updatedAt" date not null, "permissions" text, "metadata" text);
  create index "session_userId_idx" on "session" ("userId");
  create index "account_userId_idx" on "account" ("userId");
  create index "verification_identifier_idx" on "verification" ("identifier");
  create index "passkey_userId_idx" on "passkey" ("userId");
  create index "passkey_credentialID_idx" on "passkey" ("credentialID");
  create index "apikey_configId_idx" on "apikey" ("configId");
  create index "apikey_referenceId_idx" on "apikey" ("referenceId");
  create index "apikey_key_idx" on "apikey" ("key");
  create unique index "account_issuer_accountId_uidx" on "account" ("issuer", "accountId");

  CREATE TABLE invites (
    id          INTEGER PRIMARY KEY,
    email       TEXT NOT NULL,
    url         TEXT NOT NULL,
    created_by  TEXT,               -- user.id or NULL for the CLI
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used_at     TEXT
  );
  `,

  // 8 -- saved places and walking settings, owned by an account.
  //
  //      This is what migration 5 removed and said would come back with an owner. The
  //      owner is `user_id`, it is NOT NULL, and every query filters on it, so "whose
  //      row is this" is answered by the WHERE clause rather than by a check after the
  //      read that someone can forget to write.
  //
  //      The place's coordinate is stored rather than resolved on read: it is the key
  //      the walking neighbourhood is computed against, and a saved place must survive
  //      an EFA address id that stops resolving. `ref` keeps the underlying place id so
  //      trips can still be planned by it.
  //
  //      Settings are a row per user with the same defaults as the schema, so a missing
  //      row and a fresh row mean the same thing and nothing has to backfill.
  `
  CREATE TABLE places (
    id          INTEGER PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('stop','address','poi','coordinate')),
    ref         TEXT,
    name        TEXT NOT NULL,
    lat         REAL NOT NULL,
    lon         REAL NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX places_user_idx ON places(user_id, sort_order, id);

  CREATE TABLE user_settings (
    user_id                   TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    speed_kmh                 REAL NOT NULL DEFAULT 6,
    max_walk_minutes          INTEGER NOT NULL DEFAULT 20,
    transfer_penalty_minutes  REAL NOT NULL DEFAULT 5,
    walk_multiplier           REAL NOT NULL DEFAULT 1,
    catch_buffer_minutes      REAL NOT NULL DEFAULT 1,
    updated_at                TEXT NOT NULL
  );
  `,

  // 9 -- SL's static GTFS routes and trips, so a realtime vehicle (which carries only a
  //      trip id) can be named by line and mode. Replaced wholesale on each sync; no
  //      history, because yesterday's trip ids are of no use to anyone.
  `
  CREATE TABLE gtfs_routes (
    route_id    TEXT PRIMARY KEY,
    short_name  TEXT NOT NULL,
    route_type  INTEGER NOT NULL,
    agency_id   TEXT
  );
  CREATE TABLE gtfs_trips (
    trip_id       TEXT PRIMARY KEY,
    route_id      TEXT NOT NULL,
    headsign      TEXT,
    direction_id  INTEGER,
    service_id    TEXT
  );
  CREATE INDEX gtfs_trips_route_idx ON gtfs_trips(route_id);
  `,
];
