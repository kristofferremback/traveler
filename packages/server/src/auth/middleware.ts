import type { MiddlewareHandler } from "hono";
import { AppError } from "../lib/errors.ts";
import { auth } from "./auth.ts";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

/**
 * Paths under /api that answer without a session.
 *
 * The catalog sync endpoint is here because it carries its own credential: it exists
 * only when ADMIN_TOKEN is set and checks it on every call, and a cron job holding that
 * token has no session to offer. Requiring both would be a second lock on the same door.
 *
 * The OpenAPI document is here because it is the description of the API rather than data
 * from it, and an agent that must authenticate before it can read how to authenticate is
 * stuck. It names routes and shapes, never anything an account owns.
 */
const PUBLIC_API = new Set([
  "/api/health",
  "/api/ready",
  "/api/sign-in-methods",
  "/api/catalog/sync",
  "/api/openapi.json",
]);

function isPublic(path: string): boolean {
  // The auth endpoints are how you get a session, so they cannot require one.
  return PUBLIC_API.has(path) || path === "/api/auth" || path.startsWith("/api/auth/");
}

function isRateLimited(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { statusCode?: unknown; status?: unknown };
  return e.statusCode === 429 || e.status === "TOO_MANY_REQUESTS";
}

/**
 * The gate. A session cookie or an `x-api-key` header, or nothing gets through.
 *
 * `getSession` resolves to null for a missing cookie but *throws* for an API key it does
 * not recognise, so both have to be caught: an unknown key is a 401, not a 500 with a
 * stack trace in the log.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const session = await auth.api
    .getSession({ headers: c.req.raw.headers })
    .catch((err: unknown) => {
      // The api-key plugin also throws when a valid key is over its rate limit. That is
      // not "who are you" but "slow down", and an agent that sees 401 for it will go and
      // mint a new key instead of waiting a minute.
      if (isRateLimited(err)) {
        throw new AppError(
          "rate_limited",
          "Too many requests for this API key. The limit is 120 a minute.",
          429,
        );
      }
      return null;
    });

  if (!session) {
    throw new AppError(
      "unauthenticated",
      "Logga in för att använda Traveler.",
      401,
    );
  }

  c.set("user", {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
  });
  await next();
};

/**
 * Applies the gate to everything under /api except the probes and the auth endpoints.
 *
 * An allow-list rather than per-route middleware: a route added later is behind the gate
 * by default, and letting one out is a visible edit to this file.
 */
export const apiGate: MiddlewareHandler = async (c, next) => {
  if (isPublic(c.req.path)) return next();
  return requireAuth(c, next);
};
