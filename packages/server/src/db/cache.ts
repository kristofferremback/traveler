import { db } from "./index.ts";
import { logger } from "../lib/log.ts";

const log = logger("cache");

const get = db.query<{ body: string }, [string, string]>(
  "SELECT body FROM http_cache WHERE key = ?1 AND expires_at > ?2",
);
const put = db.query(
  `INSERT INTO http_cache (key, body, stored_at, expires_at) VALUES (?1, ?2, ?3, ?4)
   ON CONFLICT(key) DO UPDATE SET body = excluded.body, stored_at = excluded.stored_at, expires_at = excluded.expires_at`,
);
const sweep = db.query("DELETE FROM http_cache WHERE expires_at <= ?1");

/**
 * Read-through cache for upstream calls.
 *
 * SL asks for restraint rather than enforcing a quota, so the honest reading is that
 * we owe them a cache. Failures are never cached -- a stale error is worse than a
 * retried request.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  produce: () => Promise<T>,
): Promise<T> {
  const now = new Date();
  const hit = get.get(key, now.toISOString());
  if (hit) {
    try {
      return JSON.parse(hit.body) as T;
    } catch {
      log.warn(`discarding unparseable cache entry ${key}`);
    }
  }

  const value = await produce();
  const expires = new Date(now.getTime() + ttlSeconds * 1000);
  put.run(key, JSON.stringify(value), now.toISOString(), expires.toISOString());
  return value;
}

export function sweepCache(): number {
  return sweep.run(new Date().toISOString()).changes;
}
