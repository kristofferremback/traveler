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
 * Calls already on their way, by key.
 *
 * A stored answer only helps the request after it. Two that overlap -- a double tap, two
 * phones, the app asking again for the map geometry it did not get the first time --
 * both miss, and for one commute that is not one duplicate call to SL but twelve. They
 * wait on the first instead. Cleared when it settles, so a failure is retried rather
 * than remembered.
 */
const inFlight = new Map<string, Promise<unknown>>();

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

  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running;

  const work = produce()
    .then((value) => {
      const stored = new Date();
      const expires = new Date(stored.getTime() + ttlSeconds * 1000);
      put.run(key, JSON.stringify(value), stored.toISOString(), expires.toISOString());
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

export function sweepCache(): number {
  return sweep.run(new Date().toISOString()).changes;
}
