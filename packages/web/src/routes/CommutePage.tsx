import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { CommuteOption, SavedPlace } from "@traveler/shared";
import { api, ApiError } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { useOverlay } from "@/lib/overlay";
import { accumulate, type Answered } from "@/lib/trips";
import { parseModes } from "@/lib/modes";
import { BottomSheet, PEEK_HEIGHT } from "@/components/BottomSheet";
import { CommuteRows } from "@/components/CommuteRows";
import { TripView } from "@/components/TripView";
import { PlaceSearch, type PlaceChoice } from "@/components/PlaceSearch";
import { TimePicker, type PlanTime } from "@/components/TimePicker";
import { ModePicker, ModePill } from "@/components/ModePicker";
import { TripControl } from "@/components/TripControl";
import type { VehicleTrip } from "@/components/TransitMap";
import { Button } from "@/components/ui/button";
import { ClockArrowDown, History, RefreshCw, Search } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The map is the screen, so it is rendered immediately -- no "show map" button.
 *
 * Still a lazy import: MapLibre and the pmtiles reader are about a megabyte, and this
 * keeps them out of the sign-in page's graph. The chunk is fetched as soon as this route
 * renders, which is the difference between "eager" and "on demand".
 */
const TransitMap = lazy(() =>
  import("@/components/TransitMap").then((m) => ({ default: m.TransitMap })),
);

/** How often the countdown is recomputed. Under a minute, so "om 4 min" is never stale. */
const TICK_MS = 10_000;
/** How far "Tidigare" moves the planning time per tap. */
const EARLIER_MS = 10 * 60_000;
/** The floating controls at their usual height, until the first measurement lands. */
const CONTROLS_HEIGHT = 124;
/** Map left between the controls and anything below them. */
const CONTROLS_CLEARANCE = 8;

type Position = { lat: number; lon: number };

/**
 * Where the phone is right now, asked for every time it is needed.
 *
 * Not cached: a commute screen left open on the walk to the stop must plan from the
 * stop, not from the front door it was opened at. A stale fix is worse than a slow one
 * here, so `maximumAge` is zero and the timeout is generous.
 */
function currentPosition(): Promise<Position> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("no geolocation"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lon: coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });
}

type PlaceRef = string;

/**
 * The screen's whole state is two place refs and an optional time in the URL.
 *
 * A ref is `me`, `place:<id>` for a saved place, or a plain place id; the time is an
 * ISO `when` with `arriveBy=1` when it is a deadline rather than a departure. That
 * makes a commute a link -- "home by five" is a bookmark -- and it makes Back mean what
 * it looks like it means.
 */
export function CommutePage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  const savedPlaces = useQuery({
    queryKey: ["places"],
    queryFn: ({ signal }) => api.places.list(signal),
    staleTime: 60_000,
  });
  const saved = useMemo(
    () => [...(savedPlaces.data?.places ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [savedPlaces.data],
  );

  // Defaults are computed rather than written into the URL: an empty "/" is the commute
  // everyone opens the app for, and it should not need a redirect to become one.
  const fromRef: PlaceRef | null = params.get("from") ?? "me";
  const toRef: PlaceRef | null =
    params.get("to") ?? (saved[0] ? `place:${saved[0].id}` : null);

  const when = params.get("when");
  const time: PlanTime = when ? { when, arriveBy: params.get("arriveBy") === "1" } : null;

  /**
   * The mode filter, in the URL beside the places and the time because it is part of
   * the same question. `modeKey` is the canonical spelling of it: the parameter is
   * normalised on the way in, so it is safe to compare and to key a query by.
   */
  const modes = useMemo(() => parseModes(params.get("modes")), [params]);
  const modeKey = modes.join(",");

  const [positionDenied, setPositionDenied] = useState(false);
  const needsPosition = fromRef === "me" || toRef === "me";
  const sameEnds = Boolean(fromRef && toRef && fromRef === toRef);

  /**
   * How much geometry to ask for, deliberately outside the query key.
   *
   * Selecting an option that has no drawn path has to refetch, but a key change would
   * empty the list to skeletons while the answer comes back -- the traveller would watch
   * the row they just tapped disappear. Same key, explicit refetch, rows stay put.
   */
  const paths = useRef<"recommended" | "all">("recommended");

  /**
   * The instant to re-ask about, when the second ask is the same question as the first.
   *
   * Asking for the geometry is not a new question, but "nu" is a different instant every
   * second, and the engine turns one plan into a dozen upstream requests whose keys are
   * the time asked about. Left to drift, the second round shares nothing with the first
   * and the tapped row waits for a whole new set of answers from SL. Pinned to what the
   * first answer was planned from, it is a dozen cache reads.
   */
  const pinnedWhen = useRef<string | null>(null);

  /**
   * The position is fetched inside the query rather than held in state and put in the
   * key: the key stays the refs the traveller chose, so a new fix on the next refresh
   * replaces the rows in place instead of emptying the list to skeletons first.
   */
  /**
   * Nothing is fetched until the traveller asks.
   *
   * Opening the app is not a question; "Sök resor", Uppdatera, Tidigare, or changing
   * an end or the time is. Position is read as part of the fetch, so a phone taken out
   * of a pocket does not fire a location request before anyone tapped anything.
   */
  const [armed, setArmed] = useState(false);
  /** The last fix, so a branch planned to "Min position" can say where that is. */
  const hereRef = useRef<Position | null>(null);

  const commute = useQuery({
    queryKey: ["commute", fromRef, toRef, time?.when ?? null, time?.arriveBy ?? false, modeKey],
    enabled: armed && Boolean(fromRef && toRef) && !sameEnds,
    // A new time keeps the old answer on screen until the new one has arrived.
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const pinned = pinnedWhen.current;
      pinnedWhen.current = null;
      let here: Position | null = null;
      if (needsPosition) {
        try {
          here = await currentPosition();
          hereRef.current = here;
          setPositionDenied(false);
        } catch {
          // Denied, unavailable or timed out all mean the same thing here: the chip has
          // to say so, because otherwise the screen never loads and never explains why.
          setPositionDenied(true);
          throw new ApiError("no_position", "Ingen åtkomst till din position.", 0);
        }
      }
      const asApiRef = (ref: PlaceRef): string =>
        ref === "me" ? `${here!.lat},${here!.lon}` : ref;
      return api.commute(
        {
          from: asApiRef(fromRef!),
          to: asApiRef(toRef!),
          ...(time
            ? { when: time.when, ...(time.arriveBy ? { arriveBy: "1" as const } : {}) }
            : pinned
              ? { when: pinned }
              : {}),
          ...(modeKey ? { modes: modeKey } : {}),
          paths: paths.current,
        },
        signal,
      );
    },
    retry: (count, err) => !(err instanceof ApiError && err.code === "no_position") && count < 3,
    // Nothing moves under the traveller's nose: the list changes only when they ask
    // (Uppdatera, Tidigare, a chip). The header says how old it is; the countdown on
    // each row keeps ticking against the same answer.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  /**
   * Tidigare adds to the list rather than replacing it, and nothing else does.
   *
   * Each step back is a fresh answer from the engine, planned from ten minutes earlier:
   * it holds what was missed since then and drops the far end of the horizon. The
   * traveller pressed it to see more, not to lose the trips already on screen, so those
   * two answers are merged. Every other change of time is a different question, and its
   * answer replaces the old one -- a deadline moved from tonight to Monday morning left
   * tonight's buses sitting under Monday's until this was a flag rather than a gap in
   * the key.
   */
  const extending = useRef(false);
  const seen = useRef<Answered>({ key: "", options: [] });
  const options = useMemo(() => {
    // Placeholder data is the previous question's answer, held on screen while this one
    // loads. Shown, never merged: folding it in would make it part of the new list.
    if (!commute.data || commute.isPlaceholderData) return seen.current.options;
    const key = `${fromRef}|${toRef}|${time?.arriveBy ? "arr" : "dep"}|${time?.when ?? "now"}|${modeKey}`;
    seen.current = accumulate(seen.current, key, commute.data.options, extending.current);
    extending.current = false;
    return seen.current.options;
  }, [commute.data, commute.isPlaceholderData, fromRef, toRef, time?.arriveBy, time?.when, modeKey]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * Trips the traveller built by branching, by id.
   *
   * Not in the list: a branch is one trip's variation, welded onto it at a stop, and it
   * belongs under that trip rather than among the engine's answers. Held here so it can
   * be the selected one on the map and reopened from the list's selection.
   */
  const [picks, setPicks] = useState<Map<string, CommuteOption>>(() => new Map());
  const selected: CommuteOption | null =
    (selectedId ? (picks.get(selectedId) ?? options.find((o) => o.id === selectedId)) : null) ??
    options[0] ??
    null;

  // A new pair of places is a new list; keeping the old selection would draw a trip
  // that is no longer on screen. So is a new mode filter, which is the same list minus
  // whatever the traveller just ruled out. A new time keeps it: the merged list still
  // has it.
  useEffect(() => {
    setSelectedId(null);
    setPicks(new Map());
    paths.current = "recommended";
  }, [fromRef, toRef, time?.arriveBy, modeKey]);

  const select = useCallback(
    (option: CommuteOption) => {
      setSelectedId(option.id);
      const drawable = option.journey.legs.some((leg) => leg.path.length > 1);
      if (!drawable && paths.current !== "all") {
        paths.current = "all";
        pinnedWhen.current = commute.data?.plannedFrom ?? null;
        void commute.refetch();
      }
    },
    [commute],
  );

  /** The selected trip's first ride, in the terms the vehicle feed can find it by. */
  const vehicleTrip = useMemo((): VehicleTrip | null => {
    const leg = selected?.journey.legs.find((l) => l.mode !== "WALK");
    const line = leg?.line?.designation;
    const boardAt = leg?.origin.scheduled;
    if (!leg || !leg.tripId || !line || !boardAt || leg.origin.lat === null || leg.origin.lon === null) return null;
    return { tripId: leg.tripId, line, boardAt, lat: leg.origin.lat, lon: leg.origin.lon };
  }, [selected]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  /**
   * Where the sheet is, in two forms, because the two readers want different things.
   *
   * The map's camera reads a settled height when it fits a trip, and that is state. The
   * basemap licence has to sit on top of the sheet through the whole drag, and that is a
   * CSS variable set on the root by hand. Running the live height through page state
   * instead re-rendered the map, the control and every row once per pointer move, which
   * is what made dragging the sheet stutter.
   */
  const root = useRef<HTMLDivElement>(null);
  const [sheetHeight, setSheetHeight] = useState(PEEK_HEIGHT);
  const trackSheet = useCallback((height: number) => {
    root.current?.style.setProperty("--map-inset", `${height}px`);
  }, []);

  /**
   * How tall the floating controls are, measured rather than assumed.
   *
   * The card and the two pills under it are as tall as their longest label: "Framme
   * imorgon 09:00" beside "Bara buss och båt" needs a second row where "Nu" beside
   * "Färdmedel" does not. Three things have to know where that stack ends: MapLibre's
   * own buttons, which sit in a DOM the app does not render and so are moved by a CSS
   * variable, the sheet, which must not cover the stack when it is opened fully, and the
   * camera, which must not fit a trip underneath it.
   */
  const controls = useRef<HTMLDivElement>(null);
  const [controlsHeight, setControlsHeight] = useState(CONTROLS_HEIGHT);
  useEffect(() => {
    const node = controls.current;
    if (!node) return;
    const watch = new ResizeObserver(() => {
      const height = Math.round(node.getBoundingClientRect().height);
      root.current?.style.setProperty("--map-top", `${height}px`);
      setControlsHeight(height);
    });
    watch.observe(node);
    return () => watch.disconnect();
  }, []);

  /**
   * The picker is a history entry, so Back closes it.
   *
   * Choosing a place replaces that entry with the new trip: the picker never survives in
   * the history it opened from, and Back from the result goes to the trip before it.
   */
  const { open: overlay, show: openOverlay, close: closeOverlay, settle } = useOverlay<string>();
  const picker =
    overlay === "from" || overlay === "to" || overlay === "time" || overlay === "modes"
      ? overlay
      : null;
  const openPicker = openOverlay as (which: "from" | "to" | "time" | "modes") => void;
  const closePicker = closeOverlay;

  /**
   * The opened trip is a history entry too, so Back on the phone returns to the list
   * with nothing refetched. Its id rides in the history state rather than the URL: a
   * shared link is the commute, not one answer to it that will have expired.
   */
  const openedId = overlay?.startsWith("trip:") ? overlay.slice("trip:".length) : null;
  const opened = openedId ? (picks.get(openedId) ?? options.find((o) => o.id === openedId) ?? null) : null;
  const openTrip = (option: CommuteOption) => {
    select(option);
    openOverlay(`trip:${option.id}`);
  };
  /** A branch replaces the trip it was opened from, in place, and is drawn at once. */
  const pickBranch = (option: CommuteOption) => {
    setPicks((prev) => new Map(prev).set(option.id, option));
    setSelectedId(option.id);
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: { overlay: `trip:${option.id}` } });
  };

  const setSearch = (
    next: Partial<Record<"from" | "to" | "when" | "arriveBy" | "modes", string | null>>,
    fromPicker: boolean,
  ) => {
    const search = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) search.set(key, value);
      else search.delete(key);
    }
    setArmed(true);
    if (fromPicker) settle(search);
    else setParams(search, { replace: true });
  };

  const setEnds = (next: { from: PlaceRef | null; to: PlaceRef | null }, fromPicker: boolean) =>
    setSearch(next, fromPicker);
  const setTime = (next: PlanTime) =>
    setSearch({ when: next?.when ?? null, arriveBy: next?.arriveBy ? "1" : null }, true);
  const setModes = (next: string[]) => setSearch({ modes: next.join(",") || null }, true);

  const swap = () => setEnds({ from: toRef, to: fromRef }, false);

  /**
   * Ten minutes earlier than the current planning time, as a history entry so Back
   * undoes it. Only when planning forwards: earlier than a deadline is a different
   * question, and the picker answers it.
   */
  const earlier = () => {
    setArmed(true);
    extending.current = true;
    const from = time ? new Date(time.when).getTime() : Date.now();
    navigate({
      pathname: location.pathname,
      search: `?${new URLSearchParams({
        ...Object.fromEntries(params),
        when: new Date(from - EARLIER_MS).toISOString(),
      }).toString()}`,
    });
  };

  /**
   * One minute past the last departure on screen, so the next answer starts where this
   * one ends. Anchored on the rows rather than a fixed step because the engine answers
   * with however far SL felt like enumerating; a fixed step would either re-fetch the
   * same trips or leap over some.
   */
  const later = () => {
    setArmed(true);
    extending.current = true;
    const anchor = options
      .filter((o) => o.status !== "missed")
      .reduce(
        (last, o) => Math.max(last, new Date(o.leaveAt).getTime()),
        time ? new Date(time.when).getTime() : Date.now(),
      );
    navigate({
      pathname: location.pathname,
      search: `?${new URLSearchParams({
        ...Object.fromEntries(params),
        when: new Date(anchor + 60_000).toISOString(),
      }).toString()}`,
    });
  };

  const fromLabel = useRefLabel(fromRef, saved, positionDenied);
  const toLabel = useRefLabel(toRef, saved, positionDenied);
  /** The destination as the API takes it, for branches. Null until a fix exists, if one is needed. */
  const toApi =
    toRef === "me" ? (hereRef.current ? `${hereRef.current.lat},${hereRef.current.lon}` : null) : toRef;

  const updatedSecondsAgo = commute.dataUpdatedAt
    ? Math.max(0, Math.round((now - commute.dataUpdatedAt) / 1000))
    : null;

  return (
    <div ref={root} className="fixed inset-0" style={{ "--map-inset": `${PEEK_HEIGHT}px` } as CSSProperties}>
      <Suspense fallback={<div className="size-full bg-[var(--color-surface-2)]" />}>
        <TransitMap
          option={selected}
          vehicleTrip={vehicleTrip}
          topInset={controlsHeight + CONTROLS_CLEARANCE}
          bottomInset={sheetHeight}
          className="commute-map relative size-full"
        />
      </Suspense>

      {/* Above the map, out of its way: the controls sit in a column that does not take
          pointer events except where a control actually is. */}
      <div
        ref={controls}
        className="pointer-events-none absolute inset-x-0 top-0 z-20 px-3 safe-top"
      >
        <TripControl
          fromLabel={fromLabel}
          toLabel={toLabel}
          time={time}
          onOpen={openPicker}
          onSwap={swap}
          trailing={<ModePill modes={modes} onOpen={() => openPicker("modes")} />}
        />
      </div>

      <BottomSheet
        label="Resor härifrån"
        topGap={controlsHeight + CONTROLS_CLEARANCE}
        onHeightChange={trackSheet}
        onSettle={setSheetHeight}
      >
        <div className="space-y-2 px-3 pb-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-[var(--color-muted)]">
              {!armed
                ? "Inget sökt än"
                : commute.isError
                  ? "Visar senaste svaret"
                  : updatedSecondsAgo === null
                    ? "Hämtar resor"
                    : `Uppdaterad för ${updatedSecondsAgo} s sedan`}
            </p>
            <div className="flex items-center gap-1">
              {commute.data?.enumerated ? (
                <span className="text-xs text-[var(--color-muted)]">
                  {options.length} resor
                </span>
              ) : null}
              {/* The only way the list changes: now, from where they are standing now. */}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => (armed ? commute.refetch() : setArmed(true))}
                disabled={commute.isFetching}
                aria-label="Uppdatera"
              >
                <RefreshCw className={cn(commute.isFetching && "animate-spin")} />
              </Button>
            </div>
          </div>

          {saved.length === 0 && !params.get("to") ? (
            <div className="space-y-2 py-2">
              <p className="text-sm">
                Spara en plats först, så visas resorna dit varje gång du öppnar appen.
              </p>
              <Button asChild size="sm">
                <Link to="/places/new">Spara en plats</Link>
              </Button>
            </div>
          ) : null}

          {sameEnds ? (
            <p className="py-2 text-sm">
              Från och till är samma plats. Byt den ena för att se resor.
            </p>
          ) : null}

          {commute.isError ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-danger)] px-3 py-2">
              <p className="text-sm">
                {commute.error instanceof ApiError
                  ? commute.error.message
                  : "Kunde inte hämta resor."}
              </p>
              <Button variant="secondary" size="sm" onClick={() => commute.refetch()}>
                Försök igen
              </Button>
            </div>
          ) : null}

          {!armed && fromRef && toRef && !sameEnds ? (
            <div className="space-y-3 py-2">
              <p className="text-[15px]">
                {fromLabel} till {toLabel}
                {time ? (time.arriveBy ? `, framme senast ${formatTime(time.when)}` : `, avgång ${formatTime(time.when)}`) : ""}.
              </p>
              <Button type="button" size="lg" onClick={() => setArmed(true)} className="w-full rounded-full">
                <Search />
                Sök resor
              </Button>
            </div>
          ) : null}

          {commute.isPending && commute.fetchStatus === "fetching" && options.length === 0 ? (
            <ul className="space-y-2" aria-busy="true" aria-label="Söker resor">
              {[0, 1, 2].map((i) => (
                <li key={i}>
                  <Skeleton className="h-20 w-full" />
                </li>
              ))}
            </ul>
          ) : null}

          {/* Paging reads down the clock: earlier trips join at the top, later at the
              bottom, so each button sits where its answer will appear. */}
          {commute.isSuccess && !opened && !time?.arriveBy && options.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={earlier}
              className="w-full rounded-full"
            >
              <History />
              Tidigare
            </Button>
          ) : null}

          {opened && toApi ? (
            <TripView
              option={opened}
              destinationName={commute.data?.toLabel ?? commute.data?.to?.name ?? toLabel}
              to={toApi}
              now={now}
              onBack={closeOverlay}
              onPick={pickBranch}
            />
          ) : options.length > 0 ? (
            <CommuteRows options={options} selectedId={selected?.id ?? null} now={now} onOpen={openTrip} />
          ) : null}

          {commute.isSuccess && options.length === 0 ? (
            <p className="py-2 text-sm">
              {modes.length > 0
                ? "Ingen resa med de valda färdmedlen. Prova fler färdmedel eller en annan tid."
                : time?.arriveBy
                  ? "Ingen resa hinner fram i tid. Prova en senare tid eller en annan plats."
                  : "Ingen resa de närmaste timmarna. Prova en annan plats eller planera resan."}
            </p>
          ) : null}

          {commute.isSuccess && !opened && !time?.arriveBy ? (
            <div className="flex gap-2">
              {/* With no rows there is no top for Tidigare to sit above, so the two
                  directions share the one line. */}
              {options.length === 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={earlier}
                  className="flex-1 rounded-full"
                >
                  <History />
                  Tidigare
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={later}
                className="flex-1 rounded-full"
              >
                <ClockArrowDown />
                Senare
              </Button>
            </div>
          ) : null}

          {commute.data?.notices.map((notice) => (
            <p key={notice} className="text-xs text-[var(--color-muted)]">
              {notice}
            </p>
          ))}
        </div>
      </BottomSheet>

      {picker === "time" ? (
        <TimePicker time={time} onPick={setTime} onClose={closePicker} />
      ) : null}

      {picker === "modes" ? (
        <ModePicker modes={modes} onPick={setModes} onClose={closePicker} />
      ) : null}

      {picker === "from" || picker === "to" ? (
        <PlaceSearch
          title={picker === "from" ? "Var börjar du?" : "Vart ska du?"}
          saved={saved}
          /* Live: the screen plans from wherever the phone is when it searches, not
             from the address it was standing at when the place was chosen. */
          currentPosition="live"
          footer={
            /* The planner is one search away rather than a fifth tab: it answers a
               different question, and only sometimes. */
            <Link
              to="/plan"
              className="inline-flex min-h-11 items-center text-sm text-[var(--color-accent)]"
            >
              Sök valfri resa
            </Link>
          }
          onPick={(choice) => {
            const ref = placeRef(choice);
            setEnds(
              picker === "from" ? { from: ref, to: toRef } : { from: fromRef, to: ref },
              true,
            );
          }}
          onClose={closePicker}
        />
      ) : null}
    </div>
  );
}

/** A choice from the search screen as this screen's kind of reference. */
function placeRef(choice: PlaceChoice): PlaceRef {
  if (choice.kind === "position") return "me";
  if (choice.kind === "saved") return `place:${choice.place.id}`;
  return choice.place.id;
}

/**
 * What a place ref is called on a chip.
 *
 * Saved places answer from the list already loaded; a plain id has to be resolved, which
 * is a cached lookup shared with every other screen that names the same place.
 */
function useRefLabel(
  ref: PlaceRef | null,
  saved: SavedPlace[],
  positionDenied: boolean,
): string {
  const plain = ref && ref !== "me" && !ref.startsWith("place:") ? ref : null;
  const resolved = useQuery({
    queryKey: ["resolve", plain],
    enabled: Boolean(plain),
    queryFn: ({ signal }) => api.resolvePlace(plain!, signal),
    staleTime: 24 * 60 * 60 * 1000,
  });

  if (!ref) return "Välj plats";
  if (ref === "me") return positionDenied ? "Min position (ingen åtkomst)" : "Min position";
  if (ref.startsWith("place:")) {
    const id = Number(ref.slice("place:".length));
    return saved.find((p) => p.id === id)?.label ?? "Sparad plats";
  }
  return resolved.data?.place.name ?? "Hämtar plats";
}
