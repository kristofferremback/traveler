# Traveler

A journey planner for SL. Read the README first; it covers the SL APIs and the two
traps that matter. This file covers what to do when changing the code.

## Identifiers

`Place.id` is always SL's `gid`, the string one, which the journey planner accepts.
`Place.siteId` is always the numeric site id, which the departures endpoint accepts.
They are not interchangeable and swapping them produces empty results rather than
errors. Never build a URL or a request from whichever one is nearest; check which
space the receiving endpoint speaks.

Never parse a payload containing `gid` with plain `JSON.parse`. Use
`parseJsonPreservingIds` from `lib/bigid.ts`. Sixteen-digit ids silently round.

## Boundaries

The SL clients in `server/src/sl` translate upstream shapes into the domain types in
`packages/shared` and nothing downstream ever sees an EFA product class, a naive
timestamp, or a `[lat, lon]` pair. When SL exposes something new, translate it there
rather than passing it through.

`packages/shared` is the contract. A request or response shape belongs in a zod schema
there, so the client and server cannot drift.

## Upstream etiquette

SL asks for restraint rather than enforcing quotas, so restraint is our job.

- Every stream goes through a hub in `realtime/hub.ts`. One poll per resource, shared
  across subscribers, stopped when the last one leaves.
- Filters apply per subscriber, not upstream. Filtering upstream fragments the hub and
  multiplies requests.
- Anything hitting SL on a user action goes through `db/cache.ts` with a TTL.
- The deviations endpoint gets one request a minute at most. That is SL's own number.

If you add an upstream call, say in the pull request how often it can fire and what
shares it.

## Failure

Degrade to something useful and say so. A search that loses the journey planner still
returns local stops. A stream that stops delivering keeps the last payload on screen
with a timestamp. A catalog sync that fails leaves the previous catalog in place.

Never invent data to fill a required field. A place with no known position returns null
and falls through to a live lookup rather than defaulting to 0, 0.

## Frontend

Mobile is the product, not a smaller version of it. Touch targets are 44 pixels; the
e2e suite fails the build below that.

Navigable state lives in the URL. A planned trip is a link, and the fields and the URL
stay aligned in both directions, including when a parameter disappears on Back.

Times render in Europe/Stockholm regardless of the device's zone, in both directions:
reading a `datetime-local` value and displaying an instant. `lib/format.ts` owns this.

## Tests

`bun run test:e2e` drives a real browser against live SL data. It starts its own
server, so it cannot pass against a stale build. Add a case for any bug you fix that a
user could have hit, and say in a comment what the regression was.
