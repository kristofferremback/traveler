import { env } from "../env.ts";
import { logger } from "../lib/log.ts";
import { describe } from "../lib/errors.ts";
import { sweepCache } from "../db/cache.ts";
import { catalogCounts } from "../db/catalog.ts";
import { lastSync, syncCatalog } from "./catalog.ts";
import { gtfsSyncReason, syncGtfs } from "./gtfs.ts";

const log = logger("scheduler");

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** Overlapping syncs would fight over the same transaction; a second caller is told so. */
export async function runSyncOnce(reason: string): Promise<boolean> {
  if (running) {
    log.warn(`sync already running, skipping trigger (${reason})`);
    return false;
  }
  running = true;
  const started = Date.now();
  try {
    log.info(`catalog sync starting (${reason})`);
    await syncCatalog();
    log.info(`catalog sync finished in ${Math.round((Date.now() - started) / 1000)}s`);
    // The static GTFS join rides along, after the catalog and never in its way: a
    // 403 here means a Trafiklab product is missing, not that stops are stale.
    const gtfsReason = gtfsSyncReason(reason === "scheduled");
    if (gtfsReason) {
      try {
        await syncGtfs();
      } catch (err) {
        log.error(`gtfs sync failed (${gtfsReason}): ${describe(err)}`);
      }
    }
    return true;
  } catch (err) {
    // A failed sync is survivable: the previous catalog is still in place and every
    // read path keeps serving it. Loud in the log, invisible to the traveller.
    log.error(`catalog sync failed: ${describe(err)}`);
    return false;
  } finally {
    running = false;
  }
}

export function isSyncRunning() {
  return running;
}

/**
 * Why a boot sync is needed, or null if the catalog is current.
 *
 * The interval timer alone is not enough: a service that restarts more often than it
 * syncs -- a deploy a day against a 24 h interval -- would never reach a scheduled tick
 * and would serve the catalog it first booted with forever.
 */
function bootSyncReason(): string | null {
  if (!env.CATALOG_SYNC_ON_BOOT) return null;
  if (catalogCounts().sites === 0) return "empty catalog on boot";
  if (gtfsSyncReason(false)) return `gtfs: ${gtfsSyncReason(false)}`;

  const last = lastSync("sites");
  if (!last || last.status !== "ok" || !last.finished_at) {
    return "no successful catalog sync on record";
  }
  // Readiness demands a finished derived pass, and the passes fail independently: a
  // sites sync can land while the derived one behind it does not. Without this, a
  // single failed derived pass leaves a healthy catalog answering 503 until the next
  // scheduled tick, and every restart in between skips the sync as "fresh".
  const derived = lastSync("derived");
  if (!derived || derived.status !== "ok" || !derived.finished_at) {
    return "no successful derived pass on record";
  }

  const ageMs = Date.now() - new Date(last.finished_at).getTime();
  if (ageMs > env.CATALOG_SYNC_INTERVAL_MS) {
    return `catalog is ${Math.round(ageMs / 3_600_000)}h old`;
  }
  return null;
}

export function startScheduler() {
  const reason = bootSyncReason();
  if (reason) {
    // Deliberately not awaited -- the server should answer health checks while it
    // fills, or Railway will kill it mid-sync. Reads serve the previous catalog
    // throughout, so a boot sync is invisible to anyone using the app.
    void runSyncOnce(reason);
  }

  timer = setInterval(() => {
    void runSyncOnce("scheduled");
    sweepCache();
  }, env.CATALOG_SYNC_INTERVAL_MS);

  log.info(
    `catalog sync scheduled every ${Math.round(env.CATALOG_SYNC_INTERVAL_MS / 3600_000)}h`,
  );
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
