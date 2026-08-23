import { env, usingDevAuthSecret, VERSION } from "./env.ts";
import { logger } from "./lib/log.ts";
import { closeDb } from "./db/index.ts";
import { startScheduler, stopScheduler } from "./sync/scheduler.ts";
import { createApp, hasWeb, webDist } from "./app.ts";

const log = logger("server");

const app = createApp();

// --- Lifecycle --------------------------------------------------------------

startScheduler();

const server = Bun.serve({
  port: env.PORT,
  hostname: env.HOST,
  // SSE connections are long-lived by design; the default timeout would sever them.
  idleTimeout: 0,
  fetch: app.fetch,
});

log.info(`Traveler ${VERSION} listening on http://${env.HOST}:${server.port}`);
log.info(`database: ${env.DATABASE_PATH}`);
log.info(`frontend: ${hasWeb ? webDist : "not built"}`);
log.info(
  `vehicle positions: ${env.TRAFIKLAB_GTFS_RT_KEY ? "enabled" : "disabled (no TRAFIKLAB_GTFS_RT_KEY)"}`,
);
log.info(`auth base url: ${env.AUTH_BASE_URL}`);
if (usingDevAuthSecret) {
  // Sessions, invite tokens and API keys are all signed with a value that is in the
  // source. Fine on a laptop, and the reason NODE_ENV=production refuses to start
  // without a real one.
  log.warn("AUTH_SECRET is unset -- using the built-in development secret");
}

function shutdown(signal: string) {
  log.info(`${signal} received, shutting down`);
  stopScheduler();
  void server.stop(true).finally(() => {
    closeDb();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
