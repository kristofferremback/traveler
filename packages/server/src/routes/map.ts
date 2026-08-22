import { Hono } from "hono";
import { existsSync, statSync } from "node:fs";
import { env } from "../env.ts";
import { logger } from "../lib/log.ts";

const log = logger("map");

export const map = new Hono();

/**
 * Basemaps.
 *
 * The production answer is a Protomaps `.pmtiles` extract on the Railway volume: one
 * file, no key, no tile server, no per-request cost, and the browser reads it directly
 * with HTTP range requests. Build one covering Stockholm with:
 *
 *   pmtiles extract https://build.protomaps.com/<date>.pmtiles stockholm.pmtiles \
 *     --bbox=17.4,58.9,19.2,60.1
 *
 * then point PMTILES_PATH at it.
 *
 * Without that file we fall back to OpenStreetMap's own raster tiles. That is fine for
 * development and explicitly not fine for anything sustained -- the OSMF tile policy
 * asks apps not to use it. The fallback announces itself in the log and in the style's
 * attribution rather than quietly becoming the permanent setup.
 */
function pmtilesAvailable(): string | null {
  const path = env.PMTILES_PATH;
  if (!path) return null;
  if (!existsSync(path)) {
    log.warn(`PMTILES_PATH is set to ${path} but no file is there; using raster fallback`);
    return null;
  }
  return path;
}

const OSM_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>';

map.get("/style.json", (c) => {
  const path = pmtilesAvailable();
  const origin = new URL(c.req.url).origin;

  if (!path) {
    return c.json({
      version: 8,
      name: "Traveler (development raster)",
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          maxzoom: 19,
          attribution: `${OSM_ATTRIBUTION} — development basemap, set PMTILES_PATH for production`,
        },
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }],
    });
  }

  return c.json({
    version: 8,
    name: "Traveler",
    glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${origin}/api/map/tiles.pmtiles`,
        attribution: OSM_ATTRIBUTION,
      },
    },
    // Deliberately minimal: a transit map wants a quiet ground so routes and vehicles
    // are the only things competing for attention.
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#f6f5f3" } },
      {
        id: "water",
        type: "fill",
        source: "protomaps",
        "source-layer": "water",
        paint: { "fill-color": "#c3d9e8" },
      },
      {
        id: "landuse",
        type: "fill",
        source: "protomaps",
        "source-layer": "landuse",
        paint: { "fill-color": "#e8ebe4" },
      },
      {
        id: "roads",
        type: "line",
        source: "protomaps",
        "source-layer": "roads",
        paint: { "line-color": "#e2ddd6", "line-width": 1 },
      },
      {
        id: "buildings",
        type: "fill",
        source: "protomaps",
        "source-layer": "buildings",
        paint: { "fill-color": "#e6e2dc" },
      },
    ],
  });
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
