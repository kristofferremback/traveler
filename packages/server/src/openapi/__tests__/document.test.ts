import { describe, expect, test } from "bun:test";
import { createApp } from "../../app.ts";
import { env } from "../../env.ts";
import { buildDocument } from "../document.ts";
import { ROUTES } from "../registry.ts";

/**
 * The document cannot drift from the routes.
 *
 * An OpenAPI document maintained by hand is wrong within a month, and an agent holding a
 * key has nothing else to go on. So the app's own routing table is the reference: every
 * route Hono has registered must be described here or be named below with a reason, and
 * every route described must exist.
 */

/** `GET /api/sites/:siteId` as the document spells it. */
function key(method: string, path: string): string {
  return `${method.toLowerCase()} ${path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`;
}

/**
 * Routes that are deliberately not in the document, and why.
 *
 * Middleware shares a key with a route on the same path, which is why `ALL /api/*` covers
 * both the gate and the 404 guard.
 */
const EXCLUDED = new Map<string, string>([
  [
    "get /api/auth/*",
    "Better Auth's own endpoints; described in prose in info.description rather than enumerated here.",
  ],
  ["post /api/auth/*", "As above."],
  ["all /api/*", "The CORS and gate middleware, and the 404 guard for unmatched API paths."],
  ["all /*", "The request logger."],
  ["get /*", "The SPA fallback: the frontend's own routes and assets, not API surface."],
  ["get /", "The API-only banner, served in place of the SPA when the frontend is not built."],
  [
    "get /api/map/tiles.pmtiles",
    "A binary basemap archive served with range requests, read by MapLibre rather than by a caller.",
  ],
  [
    "post /api/catalog/sync",
    "Operations, not product: registered only when ADMIN_TOKEN is set and guarded by that token.",
  ],
]);

const document = buildDocument();

const documented = new Set<string>();
for (const [path, operations] of Object.entries(document.paths)) {
  for (const method of Object.keys(operations as object)) documented.add(key(method, path));
}

describe("the OpenAPI document", () => {
  test("is JSON, and says it is OpenAPI 3.1", () => {
    const parsed = JSON.parse(JSON.stringify(document)) as typeof document;
    expect(parsed.openapi.startsWith("3.1")).toBe(true);
    expect(parsed.info.version).toBe(document.info.version);
  });

  test("names this instance as its server", () => {
    const servers = document.servers as Array<{ url: string }>;
    expect(servers[0]?.url).toBe(env.AUTH_BASE_URL);
  });

  test("describes every route the app registers", () => {
    const app = createApp();
    const undocumented = app.routes
      .map((route) => key(route.method, route.path))
      .filter((k) => !documented.has(k) && !EXCLUDED.has(k));

    expect([...new Set(undocumented)]).toEqual([]);
  });

  test("describes no route the app does not register", () => {
    const app = createApp();
    const registered = new Set(app.routes.map((route) => key(route.method, route.path)));
    expect([...documented].filter((k) => !registered.has(k))).toEqual([]);
  });

  test("gives every operation a response body, or an explicit empty one", () => {
    const missing: string[] = [];
    for (const route of ROUTES) {
      const operation = (document.paths[route.path] as Record<string, any>)[route.method];
      const success = operation.responses[String(route.status ?? 200)];
      if (!success) missing.push(`${key(route.method, route.path)}: no success response`);
      else if (route.response && !success.content) {
        missing.push(`${key(route.method, route.path)}: response without content`);
      } else if (!route.response && success.content) {
        missing.push(`${key(route.method, route.path)}: content on a body-less response`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("marks the streams as event streams and names their events", () => {
    for (const route of ROUTES.filter((r) => r.stream)) {
      const operation = (document.paths[route.path] as Record<string, any>)[route.method];
      const success = operation.responses["200"];
      expect(Object.keys(success.content)).toEqual(["text/event-stream"]);
      expect(success["x-sse-events"].map((e: { event: string }) => e.event)).toEqual([
        route.event!,
        "stream-error",
        "ping",
      ]);
    }
  });

  test("keeps the public routes public and everything else behind a key", () => {
    for (const route of ROUTES) {
      const operation = (document.paths[route.path] as Record<string, any>)[route.method];
      if (route.public) expect(operation.security).toEqual([]);
      else expect(operation.security).toBeUndefined();
    }
    expect(document.security).toEqual([{ apiKey: [] }, { sessionCookie: [] }]);
  });

  test("resolves every $ref it uses", () => {
    const schemas = (document.components as { schemas: Record<string, unknown> }).schemas;
    const refs = [...JSON.stringify(document).matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)];
    const dangling = refs.map((m) => m[1]!).filter((name) => !(name in schemas));
    expect([...new Set(dangling)]).toEqual([]);
  });
});
