import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { CommuteOption, SavedPlace } from "@traveler/shared";
import { api, ApiError } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { BottomSheet, PEEK_HEIGHT } from "@/components/BottomSheet";
import { CommuteCards } from "@/components/CommuteCards";
import { CommuteHero } from "@/components/CommuteHero";
import { PlacePicker } from "@/components/PlacePicker";
import { TimePicker, type PlanTime } from "@/components/TimePicker";
import { TripControl } from "@/components/TripControl";
import { Button } from "@/components/ui/button";
import { History, RefreshCw, Search } from "lucide-react";
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

  const commute = useQuery({
    queryKey: ["commute", fromRef, toRef, time?.when ?? null, time?.arriveBy ?? false],
    enabled: armed && Boolean(fromRef && toRef) && !sameEnds,
    // A new time keeps the old answer on screen until the new one has arrived.
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      let here: Position | null = null;
      if (needsPosition) {
        try {
          here = await currentPosition();
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
          ...(time ? { when: time.when, ...(time.arriveBy ? { arriveBy: "1" as const } : {}) } : {}),
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
   * Tidigare adds to the list rather than replacing it.
   *
   * Each step back is a fresh answer from the engine, planned from ten minutes earlier:
   * it holds what was missed since then and drops the far end of the horizon. The
   * traveller pressed it to see more, not to lose the trips already on screen, so the
   * answers are merged: the newest response leads, in its own order, and anything only
   * an earlier response knew is kept after it. Missed options stay last. A new pair of
   * ends or a switch to a deadline starts over.
   */
  const seen = useRef<{ key: string; options: CommuteOption[] }>({ key: "", options: [] });
  const options = useMemo(() => {
    const key = `${fromRef}|${toRef}|${time?.arriveBy ? "arr" : "dep"}`;
    const fresh = commute.data?.options ?? [];
    if (seen.current.key !== key) seen.current = { key, options: [] };
    if (!commute.data) return seen.current.options;
    const ids = new Set(fresh.map((o) => o.id));
    const kept = seen.current.options.filter((o) => !ids.has(o.id));
    const merged = [...fresh, ...kept];
    const live = merged.filter((o) => o.status !== "missed");
    const missed = merged.filter((o) => o.status === "missed");
    seen.current = { key, options: [...live, ...missed] };
    return seen.current.options;
  }, [commute.data, fromRef, toRef, time?.arriveBy]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected: CommuteOption | null =
    options.find((o) => o.id === selectedId) ?? options[0] ?? null;

  // A new pair of places is a new list; keeping the old selection would draw a trip
  // that is no longer on screen. A new time keeps it: the merged list still has it.
  useEffect(() => {
    setSelectedId(null);
    paths.current = "recommended";
  }, [fromRef, toRef, time?.arriveBy]);

  const select = useCallback(
    (option: CommuteOption) => {
      setSelectedId(option.id);
      const drawable = option.journey.legs.some((leg) => leg.path.length > 1);
      if (!drawable && paths.current !== "all") {
        paths.current = "all";
        void commute.refetch();
      }
    },
    [commute],
  );

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const [sheetHeight, setSheetHeight] = useState(PEEK_HEIGHT);
  // The map keeps the trip above the sheet, but never gives away more than half its
  // height to it -- a fit with padding taller than the container has nowhere to go.
  const bottomInset = Math.min(
    sheetHeight,
    Math.round((typeof window === "undefined" ? 800 : window.innerHeight) * 0.4),
  );

  /**
   * The picker is a history entry, so Back closes it.
   *
   * Choosing a place replaces that entry with the new trip: the picker never survives in
   * the history it opened from, and Back from the result goes to the trip before it.
   */
  const picker =
    (location.state as { picker?: "from" | "to" | "time" } | null)?.picker ?? null;
  const openPicker = (end: "from" | "to" | "time") =>
    navigate({ pathname: location.pathname, search: location.search }, { state: { picker: end } });
  const closePicker = () => navigate(-1);

  const setSearch = (
    next: Partial<Record<"from" | "to" | "when" | "arriveBy", string | null>>,
    fromPicker: boolean,
  ) => {
    const search = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) search.set(key, value);
      else search.delete(key);
    }
    setArmed(true);
    if (fromPicker) {
      navigate(
        { pathname: location.pathname, search: `?${search.toString()}` },
        { replace: true, state: null },
      );
    } else {
      setParams(search, { replace: true });
    }
  };

  const setEnds = (next: { from: PlaceRef | null; to: PlaceRef | null }, fromPicker: boolean) =>
    setSearch(next, fromPicker);
  const setTime = (next: PlanTime) =>
    setSearch({ when: next?.when ?? null, arriveBy: next?.arriveBy ? "1" : null }, true);

  const swap = () => setEnds({ from: toRef, to: fromRef }, false);

  /**
   * Ten minutes earlier than the current planning time, as a history entry so Back
   * undoes it. Only when planning forwards: earlier than a deadline is a different
   * question, and the picker answers it.
   */
  const earlier = () => {
    setArmed(true);
    const from = time ? new Date(time.when).getTime() : Date.now();
    navigate({
      pathname: location.pathname,
      search: `?${new URLSearchParams({
        ...Object.fromEntries(params),
        when: new Date(from - EARLIER_MS).toISOString(),
      }).toString()}`,
    });
  };

  const fromLabel = useRefLabel(fromRef, saved, positionDenied);
  const toLabel = useRefLabel(toRef, saved, positionDenied);

  const updatedSecondsAgo = commute.dataUpdatedAt
    ? Math.max(0, Math.round((now - commute.dataUpdatedAt) / 1000))
    : null;

  return (
    <div className="fixed inset-0">
      <Suspense fallback={<div className="size-full bg-[var(--color-surface-2)]" />}>
        <TransitMap
          option={selected}
          bottomInset={bottomInset}
          className="commute-map relative size-full"
        />
      </Suspense>

      {/* Above the map, out of its way: the controls sit in a column that does not take
          pointer events except where a control actually is. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 px-3 safe-top">
        <TripControl
          fromLabel={fromLabel}
          toLabel={toLabel}
          time={time}
          onOpen={openPicker}
          onSwap={swap}
        />
      </div>

      <BottomSheet label="Resor härifrån" onHeightChange={setSheetHeight}>
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

          {selected ? <CommuteHero option={selected} now={now} /> : null}

          {options.length > 0 ? (
            <CommuteCards
              options={options}
              selectedId={selected?.id ?? null}
              now={now}
              onSelect={select}
            />
          ) : null}

          {commute.isSuccess && !time?.arriveBy ? (
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

          {commute.isSuccess && options.length === 0 ? (
            <p className="py-2 text-sm">
              {time?.arriveBy
                ? "Ingen resa hinner fram i tid. Prova en senare tid eller en annan plats."
                : "Ingen resa de närmaste timmarna. Prova en annan plats eller planera resan."}
            </p>
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

      {picker === "from" || picker === "to" ? (
        <PlacePicker
          end={picker}
          places={saved}
          onPick={(ref) =>
            setEnds(
              picker === "from" ? { from: ref, to: toRef } : { from: fromRef, to: ref },
              true,
            )
          }
          onClose={closePicker}
        />
      ) : null}
    </div>
  );
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
