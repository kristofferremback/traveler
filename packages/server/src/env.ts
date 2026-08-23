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
});

export const env = Env.parse(process.env);
export const isProd = env.NODE_ENV === "production";
export const VERSION = "0.1.0";
