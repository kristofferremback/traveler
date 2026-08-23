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

/** Paths under /api that answer without a session. */
const PUBLIC_API = new Set(["/api/health", "/api/ready"]);

function isPublic(path: string): boolean {
  // The auth endpoints are how you get a session, so they cannot require one.
  return PUBLIC_API.has(path) || path === "/api/auth" || path.startsWith("/api/auth/");
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
    .catch(() => null);

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
