# Design

How Traveler should look and behave on the screen people actually use: a phone, one hand,
often outdoors, often in a hurry. This file is the reference for visual and interaction
decisions. Code wins when the two disagree, and then this file is wrong and gets fixed.

## Who it is for

Two people in one household, commuting between Nacka and the city, checking the app on the
walk to the stop. The question is always the same: when do I leave, on what, and when am I
there. Everything else is secondary and should look secondary.

## Principles

1. The map is the screen. Controls float over it; they never own it. The map has to stay
   readable under them, in daylight and at night.
2. One glance answers the question. The recommended trip's leave time, line and arrival
   are visible without touching anything, at the size of a clock, not a caption.
3. Nothing moves under the traveller's nose. The list changes only when they ask
   (Uppdatera, Tidigare, a chip). Countdowns tick; rows do not reorder on their own.
4. Copy carries information, not layout. A label exists when the structure does not
   already say it. Swedish, sentence case, no decorative emoji.
5. Mobile is the whole product. Touch targets at least 44 px, thumb reach for anything
   frequent, safe areas respected, and nothing that only works with hover.
6. Light and dark are peers. Each is designed, not derived, and both are checked on every
   change to a surface.

## Theme

The app follows the phone's colour scheme. Dark has been the default since the start
because the first commutes were at night; daytime use showed the dark basemap is hard to
read in sunlight, and a dark UI over a light basemap (or the reverse) reads as broken.
The rule is therefore one scheme for everything on screen at once: UI tokens, basemap,
markers and route glow switch together, and the basemap is chosen for readability in
that scheme, not for looking dramatic.

Basemaps from OpenFreeMap: `liberty` in light, `fiord` in dark, chosen from the mocks on
one criterion: street names and the route readable at arm's length outdoors. (`dark` was
the one that failed it; `positron` and `bright` were the light candidates.)

Tokens live in `packages/web/src/index.css`. Line colours live in `lib/modes.ts` because
MapLibre cannot read CSS variables; those are SL's own colours and are not themed.

## The commute screen

### Layers, top to bottom

1. Från / Till chips and the time pill, in one floating group under the status bar.
2. Map controls (zoom, locate) on the right, below the chips.
3. The map: basemap, walking path (dashed), the ride (line colour with a glow on the
   selected option), the two doors, and stop callouts.
4. The sheet, over the tab bar.
5. The tab bar.

### Stop callouts

The map shows what the sheet says, at the place it happens: at the boarding stop a
callout with the line badge, the departure time and the stop name; at each change the
line you leave and the one you board; at the alighting stop the arrival time. Callouts
are DOM markers styled with the theme tokens (the basemap does not ship glyphs for a
symbol layer). They belong to the selected option only; other options draw nothing.
The callout for the next action (board this bus at 07:42) is the emphasised one.

### The sheet

Four heights instead of three:

- **Tucked**: only the handle shows above the tab bar. The map is as full-screen as it
  gets while the app still has its bar. Reached by dragging down past peek or by
  tapping the handle from peek.
- **Peek**: the recommended row is fully visible. The default.
- **Half**: the list scrolls.
- **Full**: everything but the chips.

Dragging is continuous; release snaps to the nearest height. The handle is a button, so
keyboard users cycle through the heights. Escape returns to peek.

### The hero and the alternatives

The sheet shows one option large: the selected one, which is the recommendation until
the traveller picks another. The hero carries the leave time at clock size ("3 min",
"Gå nu", "07:58"), the arrival, and the ride (line badge, departure time, boarding stop,
alighting stop). Its legs, stop by stop, sit under it.

The other options are small cards in a horizontal row: leave time, arrival, line badge,
status (Knappt, Gick). Tapping a card makes it the hero and draws it on the map; nothing
navigates. Missed options are the last cards, dimmed.

## Choosing a place

Both search screens ask the same question, so they ask it with the same control in the
same corner: the Från / swap / Till card with the time pill under it, at the top of the
screen. The commute screen floats it over the map; the planner sticks it to the top of
the page. Tapping an end opens one search screen, wherever the app needs a place.

That screen is the whole screen, and its order is fixed:

1. The title and a close button.
2. The field, right under them. Never lower: a field near the bottom is covered by the
   phone's keyboard the moment it is used, and so is every suggestion under it.
3. One list, filling the rest. Nothing sits below it.

The list is the only thing that changes, and it does not change size. Empty, it holds
Min position and the saved places, because a commute is the same two places most days.
Typed into, the same rows hold the matches. The region is sized against
`window.visualViewport` rather than the layout viewport, because a `<dialog>` is in the
top layer: Android does not shrink the layout viewport for the keyboard and iOS never
does, so without that the bottom of the list sits behind the keyboard.

The keyboard opens with the screen only where the list would otherwise be empty (saving
a new place). Where saved places are on offer, the answer is usually one tap away and a
keyboard over them would be a tap to put away again.

Every overlay on these screens is a history entry, so the phone's Back gesture closes
it. Choosing something turns that entry into the result rather than going back and then
changing the trip, which would apply the answer to the entry before it.

## Visual language

The direction is closer to a system app than to a web page: surfaces that feel like
material, generous radii, restrained borders, type that does the hierarchy.

- **Type**: the system UI font (`-apple-system, system-ui`). Sizes: 28/34 semibold for
  the leave time on the recommended row, 17 for row titles, 15 for body, 13 for
  captions. Tabular numerals for every time.
- **Materials**: floating surfaces (chips, time pill, sheet, callouts) are translucent
  with a backdrop blur over the map, opaque where they sit on another surface. Borders
  are hairlines at low contrast, never the thing that separates content; spacing and
  material do that.
- **Radii**: 22 px for the sheet and cards, full round for chips and pills, 8 px for
  badges.
- **Elevation**: one soft shadow for floating surfaces, none for content inside them.
- **Colour**: neutral surfaces; one accent for the recommendation and interactive state;
  SL's line colours are the only saturated colour on the map.
- **Motion**: 200 ms ease for heights and selection, none where `prefers-reduced-motion`
  is set.

## Mocks and decisions

Directions are compared as static mocks published to Seer before production code, in
both schemes, on a phone. A mock answers one question and is thrown away; the chosen
direction is then built properly with tests.

Decision log:

- 2026-08-27: Kris asked for a more readable map that matches his scheme in daylight,
  stop callouts with line and time, a sheet that tucks to the handle, and a sleeker,
  more system-like UI. Mocks published for three directions.
- 2026-08-27: The place picker was a bottom sheet with the search field under the saved
  places, which put it in the bottom fifth of a phone screen with its suggestions
  dropping below it, both behind the keyboard, in a sheet that resized as results came
  and went. Replaced by one full-height search screen, field at the top, one list under
  it, shared by the commute screen, the planner and saving a place. The planner's own
  two-field header went with it: it now uses the same trip control.
- 2026-08-27: Decided from the mocks. The trip control is one component (Papper): Från,
  swap and Till inside a single surface, the time pill under it. The sheet is Fokus: the
  selected option as a hero (leave time large, arrival and ride beside it), the other
  options as small cards in a horizontal row, the legs under the hero. Basemaps:
  `liberty` in light, `fiord` in dark.
