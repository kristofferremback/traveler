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

Live vehicle positions need a Trafiklab key; see below. Everything else works
without one.

## Sign-in

Traveler is invite-only. Every route under `/api` needs a session or an API key, and
the app redirects to `/signin` without one. A fresh instance has nobody inside, so the
first invite is minted on the server:

```bash
bun run invite you@example.com "Your name"
```

It prints one line, the link. Opening it signs you in, creates the account, and offers
to add a passkey; from then on "Logga in med passkey" is the whole sign-in. The link
works once and for seven days, and nothing is emailed anywhere -- passing it on is your
job. Later invites are easier to make from **Mer -> Bjud in**, which shows the link and
a QR code for the phone across the table.

Passkeys need a secure context. `http://localhost` counts, so development is fine, but
a plain `http://192.168.x.x` does not: use `./run-tailscale.sh` to reach it from a
phone. A passkey is bound to the hostname in `AUTH_BASE_URL`, so changing that origin
makes existing passkeys unusable and everyone needs a new invite.

For agents and scripts, **Mer -> API-nycklar** creates a key, shown once:

```bash
curl -H "x-api-key: $KEY" "http://localhost:3000/api/commute?from=...&to=..."
```

A key is a session, so it reaches every route the browser does. Set `AUTH_SECRET` and
`AUTH_BASE_URL` before deploying; see `.env.example`.

## Saved places

A place is anything you would name: a stop, an address, a point of interest, or a bare
coordinate. You give it a label -- "Hem", "Jobbet" -- and the underlying place keeps its
own name, so renaming never loses which stop it actually is. Saving one starts computing
its walking neighbourhood in the background, so by the time the place page opens the map
can draw what you can reach on foot: the isochrone rings, the routed walk to each stop,
and how many minutes it is there and back. The two differ, because the hill does.

**Mer -> Promenad** keeps the five walking settings on the account instead of in every
query string: speed, longest walk, what a change costs in the ranking, how walking time is
weighted, and the margin before a departure counts as missed. `/api/commute` uses them
by default, accepts `place:<id>` for a saved place at either end, and still takes any of
the five as a query parameter to override just that request. Places belong to their
owner: every statement filters on the account, so someone else's id is a 404.

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

## Testing it on a phone

```bash
./run-tailscale.sh
```

Builds, starts the server on loopback, and exposes it to the tailnet over HTTPS at
`https://<machine>.<tailnet>.ts.net:8443`. Ctrl-C stops both. It uses its own port, so
an existing `tailscale serve` mapping on `/` is left alone.

HTTPS matters more than it looks. Geolocation is a secure-context API, so over a plain
`http://192.168.x.x:3000` the "use my position" control and the entire Nearby page fail,
silently and only on the phone. Tailscale terminates TLS with a real certificate.

The server binds to `127.0.0.1` unless `HOST` says otherwise, so nothing reaches it
except through the proxy. `tailscale serve` is tailnet-only; `tailscale funnel` would
put it on the public internet, which this app is not built for.

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

Everything under `/api` needs a session or an API key, apart from the two probes and
the auth endpoints themselves. `POST /api/catalog/sync` additionally exists only when
`ADMIN_TOKEN` is set and is guarded by it; unset, the route is not registered.

`AUTH_SECRET` is required in production and the server refuses to start without it.
`AUTH_BASE_URL` must be the origin people actually reach, because it is the passkey
relying party and the base of invite links.

There are two probes, and the difference matters.

`GET /api/health` is liveness. It answers 200 from the moment the process is up, even
with an empty catalog. That is deliberate: on a first deploy the catalog is empty and
filling it takes a few seconds, and a platform health check that failed during that
window would kill the container mid-sync, every time. This is the one Railway uses.

`GET /api/ready` is readiness. It answers 503 until the stops are loaded and the search
index is built, and names what is missing. Anything that needs the catalog to actually
work should wait on this. Waiting on `/api/health` instead gets you a server that
returns `{"places": []}` for every search and no error.

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
builds the frontend, starts its own server against its own database under `.e2e/`, and
waits for `/api/ready`. It therefore proves nothing about the developer's machine: a
clean checkout syncs the catalog from SL on the first run, which takes about forty
seconds, and reuses it afterwards. It covers the search combobox by
keyboard, the URL round-trip that makes a trip shareable, the live departure board, an
API outage, and a 44-pixel floor on every touch target.
