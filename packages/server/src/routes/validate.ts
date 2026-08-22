import type { Context } from "hono";
import type { z } from "zod";
import { AppError } from "../lib/errors.ts";

/**
 * Validate the query string against a schema, turning a failure into a 400 that names
 * the offending parameter. Schemas live in @traveler/shared, so the client and server
 * cannot drift apart on what a request looks like.
 */
export function parseQuery<S extends z.ZodType>(schema: S, c: Context): z.infer<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new AppError(
      "invalid_query",
      issue ? `${issue.path.join(".") || "query"}: ${issue.message}` : "Invalid query",
      400,
      result.error.issues,
    );
  }
  return result.data;
}

export function parseIntParam(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError("invalid_param", `${name} must be a positive integer`, 400);
  }
  return parsed;
}
