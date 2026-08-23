import { z } from "zod";
import * as shared from "@traveler/shared";
import { ApiError, StreamError } from "@traveler/shared";
import { env, VERSION } from "../env.ts";
import { ROUTES, type RouteDoc } from "./registry.ts";

/**
 * The OpenAPI 3.1 document, generated from the same zod schemas the routes validate and
 * build with. Nothing here restates a field, so nothing here can disagree with the
 * server about one.
 *
 * OpenAPI 3.1 is a superset of JSON Schema draft 2020-12, which is exactly what zod 4's
 * `toJSONSchema` emits by default, so the schemas go in untranslated.
 */

type Json = Record<string, unknown>;

const SCHEMA_REF = "#/components/schemas/";

/** Query and body schemas are described as *inputs*: before defaults and coercions. */
function jsonSchema(schema: z.ZodType, io: "input" | "output"): Json {
  const json = z.toJSONSchema(schema, {
    io,
    // A shape we cannot express is better documented as "anything" than not at all.
    unrepresentable: "any",
    cycles: "ref",
    reused: "inline",
  }) as Json;
  // Meaningful in a standalone schema document, noise inside an OpenAPI one.
  delete json.$schema;
  delete json.$id;
  return json;
}

/**
 * Every zod schema exported from @traveler/shared, by its export name.
 *
 * The export name is the name the document uses in `components/schemas`, which is why
 * there is no second list of names to keep in step. Two exports of the same schema
 * (`UserSettings` is `CommuteSettings`) keep the first name alphabetically, so the
 * document is byte-stable across runs.
 */
function namedSchemas(): Map<z.ZodType, string> {
  const named = new Map<z.ZodType, string>();
  for (const [name, value] of Object.entries(shared)) {
    if (value instanceof z.ZodType && !named.has(value)) named.set(value, name);
  }
  return named;
}

interface Components {
  /** JSON Schema for every named shared schema, keyed by export name. */
  schemas: Record<string, Json>;
  /** A `$ref` for a named schema, or the schema inlined when it has no name. */
  refOrInline(schema: z.ZodType): Json;
}

function buildComponents(): Components {
  const named = namedSchemas();

  const registry = z.registry<{ id: string }>();
  for (const [schema, id] of named) registry.add(schema, { id });

  const { schemas } = z.toJSONSchema(registry, {
    io: "output",
    uri: (id) => `${SCHEMA_REF}${id}`,
    unrepresentable: "any",
    cycles: "ref",
    // "ref" would hoist anonymous repeats into a synthetic `__shared` component and
    // point at it with a nested fragment, which no OpenAPI tool resolves.
    reused: "inline",
  });

  const all: Record<string, Json> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    const json = schema as unknown as Json;
    delete json.$schema;
    delete json.$id;
    all[name] = json;
  }

  return {
    schemas: all,
    refOrInline(schema) {
      const name = named.get(schema);
      return name ? { $ref: `${SCHEMA_REF}${name}` } : jsonSchema(schema, "output");
    },
  };
}

/** Every `$ref` reachable from these roots, so unused components can be dropped. */
function reachable(roots: string[], schemas: Record<string, Json>): Set<string> {
  const keep = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (keep.has(name) || !schemas[name]) continue;
    keep.add(name);
    for (const match of JSON.stringify(schemas[name]).matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)) {
      queue.push(match[1]!);
    }
  }
  return keep;
}

function parameters(route: RouteDoc, components: Components): Json[] {
  const out: Json[] = [];

  for (const [name, schema] of Object.entries(route.params ?? {})) {
    out.push({ name, in: "path", required: true, schema: jsonSchema(schema, "input") });
  }

  if (route.query) {
    const json = jsonSchema(route.query, "input");
    const properties = (json.properties ?? {}) as Record<string, Json>;
    const required = new Set((json.required ?? []) as string[]);
    for (const [name, schema] of Object.entries(properties)) {
      const parameter: Json = { name, in: "query", required: required.has(name), schema };
      if (typeof schema.description === "string") parameter.description = schema.description;
      out.push(parameter);
    }
  }

  return out;
}

function jsonBody(schema: Json, description: string): Json {
  return { description, content: { "application/json": { schema } } };
}

function errorResponse(components: Components, description: string): Json {
  return jsonBody(components.refOrInline(ApiError), description);
}

/**
 * The success response, plus the failures a caller has to handle.
 *
 * Streams answer `text/event-stream`: named events carrying the same JSON body the
 * non-streaming route returns, listed under `x-sse-events` because OpenAPI has no way to
 * describe an event stream's event names.
 */
function responses(route: RouteDoc, components: Components): Json {
  const out: Json = {};
  const status = String(route.status ?? 200);

  if (route.stream && route.response) {
    out[status] = {
      description: `An event stream. \`${route.event}\` events carry the same body the non-streaming route returns; \`stream-error\` reports an upstream failure without ending the stream; \`ping\` is a heartbeat every 25 seconds.`,
      content: {
        "text/event-stream": {
          schema: {
            type: "string",
            description: "Server-sent events; see `x-sse-events` for the payload of each.",
          },
        },
      },
      "x-sse-events": [
        { event: route.event, schema: components.refOrInline(route.response) },
        { event: "stream-error", schema: components.refOrInline(StreamError) },
        { event: "ping", schema: { type: "string", enum: [""] } },
      ],
    };
  } else if (route.response) {
    out[status] = jsonBody(components.refOrInline(route.response), route.summary);
  } else {
    out[status] = { description: "No content." };
  }

  if (route.query || route.body || route.params) {
    out["400"] = errorResponse(components, "The request did not validate; the message names the parameter.");
  }
  if (!route.public) {
    out["401"] = errorResponse(components, "No session cookie and no valid API key.");
    out["429"] = errorResponse(components, "Rate limit exceeded: 120 requests a minute per API key.");
  }
  if (route.notFound) {
    out["404"] = errorResponse(components, "No such resource, or it belongs to someone else.");
  }
  for (const extra of route.extra ?? []) {
    out[String(extra.status)] = jsonBody(
      components.refOrInline(extra.response ?? ApiError),
      extra.description,
    );
  }

  return out;
}

function operation(route: RouteDoc, components: Components): Json {
  const op: Json = { operationId: operationId(route), summary: route.summary };
  if (route.description) op.description = route.description;
  op.tags = route.tags;

  const params = parameters(route, components);
  if (params.length > 0) op.parameters = params;

  if (route.body) {
    op.requestBody = {
      required: true,
      content: { "application/json": { schema: jsonSchema(route.body, "input") } },
    };
  }

  // The document-wide default is "a key or a cookie"; a public route says "neither".
  if (route.public) op.security = [];

  op.responses = responses(route, components);
  return op;
}

/** `getCommute`, `getSitesSiteIdDepartures` -- stable, and unique per method and path. */
function operationId(route: RouteDoc): string {
  const words = route.path
    .replace(/^\/api\/?/, "")
    .split(/[/.]/)
    .filter(Boolean)
    .map((segment) => segment.replace(/[{}]/g, ""))
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1));
  return route.method + words.join("");
}

const DESCRIPTION = `Traveler is a journey planner for Stockholm's public transport, built on SL's own APIs.

This document is generated from the schemas the server validates with, so it cannot drift from the running instance.

**Getting a key.** Sign in, then **Mer → API-nycklar** creates one; it is shown once. Send it as \`x-api-key\`. A key is a session, so it reaches every route a browser does. The browser itself uses the \`better-auth.session_token\` cookie instead, and both are accepted everywhere.

**Rate limit.** 120 requests a minute per key. Over that is a 429.

**Sign-in and key management** live under \`/api/auth/*\` and are Better Auth's own endpoints, documented at https://better-auth.com. They are not enumerated here. \`POST /api/auth/api-key/create\` mints a key from a session cookie, and like every auth endpoint it requires an \`Origin\` header matching this instance.

**Live data.** The \`/stream\` routes answer \`text/event-stream\` rather than JSON. Their events are named \`departures\`, \`vehicles\` and \`deviations\` for data, \`stream-error\` for an upstream failure that did not end the stream (named that way because an SSE event called \`error\` is indistinguishable from the socket dropping), and \`ping\` for the 25-second heartbeat.

**Ids.** SL has two id spaces for the same stop and they are not interchangeable: departure boards are addressed by the numeric \`siteId\`, trips by the string \`id\` (SL's gid). Place ids are opaque and must round-trip untouched.

**Time.** Every timestamp is an absolute instant, ISO 8601 with an offset.`;

export interface OpenApiDocument extends Json {
  openapi: string;
  info: Json;
  paths: Record<string, Json>;
}

export function buildDocument(): OpenApiDocument {
  const components = buildComponents();

  const paths: Record<string, Json> = {};
  for (const route of ROUTES) {
    const path = (paths[route.path] ??= {});
    path[route.method] = operation(route, components);
  }

  const tags: Json[] = [];
  for (const route of ROUTES) {
    for (const tag of route.tags) {
      if (!tags.some((t) => t.name === tag)) tags.push({ name: tag });
    }
  }

  const roots = [...JSON.stringify(paths).matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)].map(
    (m) => m[1]!,
  );
  const keep = reachable(roots, components.schemas);
  const schemas: Record<string, Json> = {};
  for (const name of Object.keys(components.schemas).sort()) {
    if (keep.has(name)) schemas[name] = components.schemas[name]!;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Traveler",
      version: VERSION,
      description: DESCRIPTION,
    },
    servers: [{ url: env.AUTH_BASE_URL, description: "This instance." }],
    tags,
    security: [{ apiKey: [] }, { sessionCookie: [] }],
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "A key from Mer → API-nycklar. 120 requests a minute.",
        },
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "better-auth.session_token",
          description: "The browser's session cookie, set by signing in.",
        },
      },
      schemas,
    },
  };
}
