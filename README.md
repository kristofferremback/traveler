# Traveler

A journey planner for SL, built because the official app is frustrating to use.

Bun and Hono on the server, SQLite for storage, React and Tailwind on the front,
MapLibre for maps. One process serves both halves.

## Running it

```bash
bun install
bun run sync      # pull SL's stop catalog into SQLite, about 20 seconds
bun run dev       # API on :3000, Vite on :5173
```

Open http://localhost:5173. The Vite server proxies `/api` to the Bun server.

For a single-origin run, the way it is deployed:

```bash
bun run build
bun run start     # http://localhost:3000
```

Nothing here needs an API key. Live vehicle positions do; see below.

## The SL APIs

Three separate APIs with three different vocabularies, all open.

| What | Endpoint | Used for |
| --- | --- | --- |
| SL Transport | `transport.integration.sl.se/v1` | The stop catalog and departure boards |
| Journey planner | `journeyplanner.integration.sl.se/v2` | Trips, and searching addresses and points of interest |
| Deviations | `deviations.integration.sl.se/v1` | Disruptions, filterable by stop, line and mode |

Two things about them are worth knowing before you touch this code.

**`gid` does not fit in a JavaScript number.** SL's global identifiers are sixteen
digits, around 9.09e15, past `Number.MAX_SAFE_INTEGER` at 9.007e15. `JSON.parse`
reads them as doubles and rounds. Measured against the live catalog that turns 6510
distinct sites into 3493: sites 103, 104 and 105 all become `9091001000000104`. It
throws nothing. It plans your trip to a different island. `lib/bigid.ts` quotes those
fields in the raw text before parsing, and they stay strings everywhere after that.

**There are two id spaces for the same stop.** Departures are addressed by the numeric
`site.id` (`9189`). Trips are addressed by the string `site.gid`
(`9091001000009189`), which is also the journey planner's global location id. Passing
one where the other belongs returns an empty result rather than an error. `Place.id`
is always the gid; `Place.siteId` is always the numeric one.

Timestamps disagree too. SL Transport sends naive Stockholm wall-clock, the journey
planner sends UTC, deviations send an offset. Everything is normalised to an absolute
instant in `lib/time.ts` and rendered in Stockholm time regardless of the device's
zone, because someone checking the last train home from an airport wants Stockholm's
clock.

The journey planner also accepts `itd_trip_date_time_dep_arr=dep|arr`, which is
undocumented. It is what makes arrive-by search work. Its gateway validates query
parameters and names the offending one in the 400 body, which is how the parameter was
found and how you can find others.

## Layout

```
packages/shared   Domain types and the API contract, as zod schemas
packages/server   Bun, Hono, SQLite, the SL clients, SSE
packages/web      React, Tailwind, MapLibre
e2e               Playwright, against a real browser and live SL data
```

The server owns three things worth calling out.

**The catalog.** SL publishes 6510 sites, 14 195 stop points and 665 lines as static
lists. `bun run sync` pulls them into SQLite and diffs by content hash, so a re-run
reports nothing changed. Rows are soft-deleted rather than dropped, so a saved trip
referencing a retired stop degrades to "this stop is gone" instead of breaking. Stop
search runs entirely against this: FTS5 with diacritics folded, so `sodermalm` finds
Södermalm and `t-cent` finds T-Centralen.

Addresses and points of interest have no bulk export, so those are asked for live and
cached briefly. Only stops get the pull-and-diff treatment.

**Shared polling.** Every SSE stream is fed by one upstream poll shared across
subscribers, and polling stops when the last client disconnects. Three clients watching
one stop for twenty seconds produce two SL requests, not six. Filters are applied per
subscriber rather than upstream, so ten people watching Slussen with ten different mode
filters still cost one request.

**Failure containment.** A failed catalog sync leaves the previous catalog in place. A
failed journey-planner call still returns local stop results. A stream that stops
delivering keeps the last board on screen with a visible timestamp rather than blanking.

## Configuration

Copy `.env.example` to `.env`. Everything has a working default except the two below.

`TRAFIKLAB_GTFS_RT_KEY` enables live vehicle positions, the one feature that needs an
account. The feed is GTFS-Realtime protobuf from Trafiklab, updating every two seconds.
Without the key every other feature works and the map says why the vehicles are missing.
Note the free Bronze tier allows 30 000 calls a month, which at any useful interval is
about a day of one person watching a map. Silver is 2 000 000.

`ADMIN_TOKEN` enables `POST /api/catalog/sync`. Unset, the route is not registered,
which is the right default for a public URL: it is a ten-megabyte download and a
rewrite of three tables.

## Maps

MapLibre with a Protomaps `.pmtiles` archive on the volume. No key, no tile server, and
the browser reads only the ranges it needs.

```bash
pmtiles extract https://build.protomaps.com/<date>.pmtiles stockholm.pmtiles \
  --bbox=17.4,58.9,19.2,60.1
```

Put it on the volume and set `PMTILES_PATH`. Without it the style falls back to
OpenStreetMap raster tiles, which is fine for development and not allowed for an app in
regular use under the OSMF tile policy. The fallback says so in the log and in the
attribution.

## Deploying

Railway, one service, Dockerfile build. Mount a volume and set `DATABASE_PATH` to a path
on it, for example `/data/traveler.db`. On first boot the catalog is empty, so the
server starts a sync in the background and answers health checks while it runs. It takes
about five seconds.

The catalog re-syncs every 24 hours, and also on boot if the last successful sync is
older than that, since a service that redeploys daily would otherwise never reach a
scheduled tick.

## Tests

```bash
bun run test        # unit tests for the parsing and formatting that bit us
bun run test:e2e    # Playwright, real browser, live SL data
bun run check       # types, unit, e2e
```

The unit tests cover the traps: id precision, the three timestamp formats, Stockholm
time in both directions, and a guard that line colours stay literal values MapLibre can
parse rather than CSS variables it silently renders black.

Playwright drives a real browser against a real server and the live SL APIs. The suite
starts its own server so it never tests a stale build. It covers the search combobox by
keyboard, the URL round-trip that makes a trip shareable, the live departure board, an
API outage, and a 44-pixel floor on every touch target.
