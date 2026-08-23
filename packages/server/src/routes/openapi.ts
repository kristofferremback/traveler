import { Hono } from "hono";
import { buildDocument } from "../openapi/document.ts";

export const openapi = new Hono();

/**
 * Built once. The routes and the schemas are fixed at import time, so rebuilding it per
 * request would only spend CPU to produce the same bytes.
 */
let document: string | null = null;

/**
 * The contract, for agents.
 *
 * Public, like the two probes: it is the description of the API, not data from it, and
 * an agent that has to authenticate before it can learn how to authenticate is stuck.
 */
openapi.get("/openapi.json", (c) => {
  document ??= JSON.stringify(buildDocument());
  c.header("cache-control", "public, max-age=3600");
  return c.body(document, 200, { "content-type": "application/json; charset=UTF-8" });
});
