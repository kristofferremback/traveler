import { Hono } from "hono";
import { existsSync, statSync } from "node:fs";
import { env } from "../env.ts";
import { MapStyleQuery } from "@traveler/shared";
import { parseQuery } from "./validate.ts";
import { logger } from "../lib/log.ts";
import { describe } from "../lib/errors.ts";

const log = logger("map");

export const map = new Hono();

/**
 * Basemaps.
 *
 * Two answers, in this order.
 *
 * A Protomaps `.pmtiles` extract on the volume is the self-hosted one: one file, no key,
 * no tile server, no per-request cost, and the browser reads it directly with HTTP range
 * requests. Build one covering Stockholm with:
 *
 *   pmtiles extract https://build.protomaps.com/<date>.pmtiles stockholm.pmtiles \
 *     --bbox=17.4,58.9,19.2,60.1
 *
 * then point PMTILES_PATH at it.
 *
 * Without that file, OpenFreeMap: keyless, no quota, no account, and their styles carry
 * the OpenStreetMap attribution they owe. That is the default because the map is now the
 * home screen, and a home screen cannot rest on OSM's raster tiles -- the OSMF tile
 * policy asks apps not to, and a "development fallback" on the first screen of the app
 * is not development.
 */
function pmtilesAvailable(): string | null {
  const path = env.PMTILES_PATH;
  if (!path) return null;
  if (!existsSync(path)) {
    log.warn(`PMTILES_PATH is set to ${path} but no file is there; using OpenFreeMap`);
    return null;
  }
  return path;
}

type Theme = "dark" | "light";

const OPENFREEMAP_STYLE: Record<Theme, string> = {
  dark: "https://tiles.openfreemap.org/styles/fiord",
  light: "https://tiles.openfreemap.org/styles/liberty",
};

/** Their styles change about never, and a style fetch is on the critical path of a map. */
const STYLE_TTL_MS = 6 * 60 * 60 * 1000;
const styleCache = new Map<Theme, { style: unknown; expiresAt: number }>();

async function openFreeMapStyle(theme: Theme): Promise<unknown> {
  const hit = styleCache.get(theme);
  if (hit && hit.expiresAt > Date.now()) return hit.style;

  try {
    const res = await fetch(OPENFREEMAP_STYLE[theme], { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`OpenFreeMap answered ${res.status}`);
    const style = await res.json();
    styleCache.set(theme, { style, expiresAt: Date.now() + STYLE_TTL_MS });
    return style;
  } catch (err) {
    // A style that was good six hours ago beats no map at all. The expiry is a refresh
    // hint, not a correctness bound: their styles change about never.
    if (hit) {
      log.warn(`OpenFreeMap unreachable, serving the cached ${theme} style: ${describe(err)}`);
      return hit.style;
    }
    throw err;
  }
}

const OSM_ATTRIBUTION = '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>';

/**
 * The pmtiles style, in two flavours.
 *
 * Deliberately minimal: a transit map wants a quiet ground so routes and vehicles are
 * the only things competing for attention. The dark flavour is not the light one dimmed
 * -- water has to stay darker than land in both, or the archipelago reads inside out.
 */
function pmtilesStyle(origin: string, theme: Theme) {
  const palette =
    theme === "light"
      ? {
          background: "#f6f5f3",
          water: "#c3d9e8",
          landuse: "#e8ebe4",
          roads: "#e2ddd6",
          buildings: "#e6e2dc",
        }
      : {
          background: "#0e1420",
          water: "#0a1626",
          landuse: "#131b28",
          roads: "#1f2937",
          buildings: "#182234",
        };

  return {
    version: 8,
    name: `Traveler (${theme})`,
    glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${origin}/api/map/tiles.pmtiles`,
        attribution: OSM_ATTRIBUTION,
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": palette.background } },
      {
        id: "water",
        type: "fill",
        source: "protomaps",
        "source-layer": "water",
        paint: { "fill-color": palette.water },
      },
      {
        id: "landuse",
        type: "fill",
        source: "protomaps",
        "source-layer": "landuse",
        paint: { "fill-color": palette.landuse },
      },
      {
        id: "roads",
        type: "line",
        source: "protomaps",
        "source-layer": "roads",
        paint: { "line-color": palette.roads, "line-width": 1 },
      },
      {
        id: "buildings",
        type: "fill",
        source: "protomaps",
        "source-layer": "buildings",
        paint: { "fill-color": palette.buildings },
      },
    ],
  };
}

map.get("/style.json", async (c) => {
  // The same schema the OpenAPI document describes, so a mistyped theme is the 400 the
  // document promises rather than a quiet dark map.
  const { theme } = parseQuery(MapStyleQuery, c);
  const path = pmtilesAvailable();

  if (path) {
    c.header("cache-control", "public, max-age=3600");
    return c.json(pmtilesStyle(new URL(c.req.url).origin, theme));
  }

  try {
    const style = await openFreeMapStyle(theme);
    c.header("cache-control", "public, max-age=3600");
    return c.json(style);
  } catch (err) {
    // No silent second choice: a map drawn on a basemap nobody chose is worse than a
    // map that says its ground is missing, which is what the client renders on this.
    log.warn(`OpenFreeMap ${theme} style unavailable: ${err instanceof Error ? err.message : err}`);
    return c.json(
      {
        error: {
          code: "basemap_unavailable",
          message: "The basemap style could not be fetched. Set PMTILES_PATH to self-host one.",
        },
      },
      502,
    );
  }
});

/**
 * Serve the archive with range support, which is the whole point of the format -- the
 * client fetches the few kilobytes of the tiles it needs rather than the whole file.
 */
map.get("/tiles.pmtiles", (c) => {
  const path = pmtilesAvailable();
  if (!path) return c.json({ error: { code: "no_basemap", message: "No .pmtiles configured" } }, 404);

  const size = statSync(path).size;
  const range = c.req.header("range");
  const file = Bun.file(path);

  if (!range) {
    return new Response(file, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(size),
        "accept-ranges": "bytes",
        "cache-control": "public, max-age=86400",
      },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) return c.body(null, 416, { "content-range": `bytes */${size}` });

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end || start >= size) {
    return c.body(null, 416, { "content-range": `bytes */${size}` });
  }

  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=86400",
    },
  });
});
