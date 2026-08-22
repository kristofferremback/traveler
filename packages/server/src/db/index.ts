import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { env } from "../env.ts";
import { logger } from "../lib/log.ts";
import { MIGRATIONS } from "./migrations.ts";

const log = logger("db");

function configure(db: Database) {
  // WAL keeps the realtime pollers from blocking reads; on Railway's volume this is
  // the difference between a responsive board and a stalled one during a catalog sync.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA temp_store = MEMORY");
}

function migrate(db: Database) {
  const current = (
    db.query("PRAGMA user_version").get() as { user_version: number }
  ).user_version;

  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database is at schema version ${current} but this build only knows ${MIGRATIONS.length}. ` +
        `Refusing to start against a newer database.`,
    );
  }
  if (current === MIGRATIONS.length) return;

  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version]!;
    log.info(`applying migration ${version + 1}/${MIGRATIONS.length}`);
    db.transaction(() => {
      db.exec(sql);
      // user_version does not accept a bound parameter.
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
  log.info(`schema at version ${MIGRATIONS.length}`);
}

function open(): Database {
  const path = env.DATABASE_PATH;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  configure(db);
  migrate(db);
  return db;
}

export const db = open();

export function closeDb() {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // A checkpoint failure on shutdown is not worth masking the real exit reason.
  }
  db.close(false);
}
