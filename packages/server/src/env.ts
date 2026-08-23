import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().default(3000),
  /**
   * Interface to bind. Loopback by default.
   *
   * Bun.serve binds to every interface when given no hostname -- it reports "localhost"
   * but the socket is on `*` -- so a dev server is reachable from the whole LAN without
   * anyone deciding it should be. Exposure is opt-in: set HOST=0.0.0.0, or better, put
   * `tailscale serve` in front and leave this alone.
   */
  HOST: z.string().default("127.0.0.1"),
  DATABASE_PATH: z.string().default("./data/traveler.db"),
  TRAFIKLAB_GTFS_RT_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
  VEHICLE_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(4000),
  CATALOG_SYNC_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(24 * 60 * 60 * 1000),
  CATALOG_SYNC_ON_BOOT: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  /**
   * Enables the manual catalog-refresh endpoint. Unset, the route is not registered at
   * all -- a public deployment should not expose a button that starts a multi-megabyte
   * download and a full table rewrite.
   */
  ADMIN_TOKEN: z
    .string()
    .trim()
    .min(16, "ADMIN_TOKEN must be at least 16 characters to be worth having")
    .optional()
    .transform((v) => (v ? v : undefined)),
  /**
   * Pedestrian routing. The public FOSSGIS server is free under a fair-use policy of one
   * request per second per client, which the client enforces. Point this at your own
   * Valhalla if that ever stops being enough.
   */
  VALHALLA_URL: z.string().url().default("https://valhalla1.openstreetmap.de"),
  /** Directory of built frontend assets. Served only when it exists. */
  WEB_DIST: z.string().default("../web/dist"),
  /** Optional .pmtiles basemap on the persistent volume, served with range requests. */
  PMTILES_PATH: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),

  // --- Auth -----------------------------------------------------------------

  /**
   * Signing key for sessions, invite tokens and API keys. Required in production;
   * development and test fall back to a fixed string so a fresh clone runs, and the
   * server says so at boot. Rotating it signs everyone out, which is the intended
   * emergency lever.
   */
  AUTH_SECRET: z
    .string()
    .trim()
    .min(32, "AUTH_SECRET must be at least 32 characters")
    .optional()
    .transform((v) => (v ? v : undefined)),
  /**
   * The origin this instance is reached on. It is the passkey relying party (a passkey
   * is bound to the hostname, so this being wrong makes every passkey silently
   * unusable), the base of invite links, and what decides whether session cookies are
   * marked secure. Defaults to localhost on PORT.
   */
  AUTH_BASE_URL: z.string().url().optional(),
  /** Extra origins allowed to call the auth API, e.g. the Vite dev server on :5173. */
  AUTH_TRUSTED_ORIGINS: z
    .string()
    .trim()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean)
        : [],
    ),
});

const parsed = Env.parse(process.env);

export const isProd = parsed.NODE_ENV === "production";

/**
 * The development fallback secret. Deliberately obvious: anyone who sees it in a log or
 * a cookie should recognise that this instance is not protecting anything.
 */
const DEV_AUTH_SECRET = "traveler-development-secret-change-me-in-production";

if (isProd && !parsed.AUTH_SECRET) {
  throw new Error(
    "AUTH_SECRET is required when NODE_ENV=production. Generate one with `openssl rand -base64 32`.",
  );
}

if (isProd && !parsed.AUTH_BASE_URL) {
  // Without it, invite links point at localhost and every passkey is registered for a
  // hostname nobody reaches the instance on. Better to refuse to start than to mint
  // accounts that cannot be used.
  throw new Error(
    "AUTH_BASE_URL is required when NODE_ENV=production, e.g. https://traveler.example.com",
  );
}

/** True when the dev fallback is in use; index.ts and the CLI warn about it at boot. */
export const usingDevAuthSecret = !parsed.AUTH_SECRET;

export const env = {
  ...parsed,
  AUTH_SECRET: parsed.AUTH_SECRET ?? DEV_AUTH_SECRET,
  AUTH_BASE_URL: parsed.AUTH_BASE_URL ?? `http://localhost:${parsed.PORT}`,
};

export const VERSION = "0.1.0";
