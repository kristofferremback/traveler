import { Hono } from "hono";
import { cors } from "hono/cors";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { env, isProd, usingDevAuthSecret, VERSION } from "./env.ts";
import { logger } from "./lib/log.ts";
import { AppError, describe } from "./lib/errors.ts";
import { closeDb } from "./db/index.ts";
import { startScheduler, stopScheduler } from "./sync/scheduler.ts";
import { places } from "./routes/places.ts";
import { transit } from "./routes/transit.ts";
import { health } from "./routes/health.ts";
import { map } from "./routes/map.ts";
import { commute } from "./routes/commute.ts";
import { account } from "./routes/account.ts";
import { savedPlaces } from "./routes/savedPlaces.ts";
import { auth } from "./auth/auth.ts";
import { apiGate } from "./auth/middleware.ts";

const log = logger("server");

const app = new Hono();

// The API and the frontend are served from one origin in production, so CORS only
// exists for the split-port dev setup.
if (!isProd) app.use("/api/*", cors());

app.use("*", async (c, next) => {
  const started = Bun.nanoseconds();
  await next();
  // Streams never "finish" in a useful sense; logging them on open would be noise.
  if (!c.req.path.endsWith("/stream")) {
    log.debug(
      `${c.req.method} ${c.req.path} -> ${c.res.status} in ${Math.round((Bun.nanoseconds() - started) / 1e6)}ms`,
    );
  }
});

/**
 * Sign-in, passkeys and API keys, handled by Better Auth.
 *
 * Mounted before the gate: these are how a caller gets a session, so requiring one here
 * would lock everybody out. `apiGate` skips /api/auth/* for the same reason.
 */
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

/**
 * The gate.
 *
 * Everything under /api needs a session cookie or an API key, except the two probes and
 * the auth endpoints themselves. Registered before the routes so a route added later is
 * behind it without anyone remembering to do anything. The app shell and its assets are
 * served below and stay public: the sign-in page has to load.
 */
app.use("/api/*", apiGate);

app.route("/api", health);
app.route("/api/places", places);
app.route("/api", transit);
app.route("/api/map", map);
app.route("/api", commute);
app.route("/api", account);
// After /api/places: the search routes there are literal paths, and this one's
// `/places/:id` would otherwise answer for `/places/search`.
app.route("/api", savedPlaces);

/**
 * Unmatched API paths are a 404, not the app shell.
 *
 * The SPA fallback below answers every unmatched GET with index.html so client-side
 * routes work on a hard refresh. Without this guard it also answers `/api/typo` with
 * 200 and a page of HTML, so a client bug surfaces as "JSON.parse: unexpected token <"
 * somewhere far away instead of a plain 404.
 */
app.all("/api/*", (c) =>
  c.json(
    { error: { code: "not_found", message: `No API route for ${c.req.method} ${c.req.path}` } },
    404,
  ),
);

app.onError((err, c) => {
  if (err instanceof AppError) {
    if (err.status >= 500) log.error(`${err.code}: ${err.message}`);
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      err.status as 400,
    );
  }
  log.error(`unhandled: ${describe(err)}`, err);
  return c.json(
    { error: { code: "internal_error", message: "Something went wrong on our side." } },
    500,
  );
});

// --- Frontend ---------------------------------------------------------------

const webDist = resolve(import.meta.dir, "..", env.WEB_DIST);
const hasWeb = existsSync(webDist);

if (hasWeb) {
  app.get("*", async (c) => {
    const path = c.req.path === "/" ? "/index.html" : c.req.path;
    const file = Bun.file(resolve(webDist, `.${path}`));

    if (await file.exists()) {
      // Vite fingerprints everything under /assets, so those are safe to pin.
      const immutable = path.startsWith("/assets/");
      return new Response(file, {
        headers: {
          "cache-control": immutable
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    }

    // Client-side routes have no file of their own; the app shell answers for them.
    const shell = Bun.file(resolve(webDist, "index.html"));
    if (await shell.exists()) {
      return new Response(shell, { headers: { "cache-control": "no-cache" } });
    }
    return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
  });
} else {
  app.get("/", (c) =>
    c.json({
      name: "Traveler",
      version: VERSION,
      note: "API only -- no frontend build found. Run `bun run build`, or use the Vite dev server.",
    }),
  );
}

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
