import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CommuteOption, SavedPlace } from "@traveler/shared";
import { api, ApiError } from "@/lib/api";
import { BottomSheet, PEEK_HEIGHT } from "@/components/BottomSheet";
import { CommuteList } from "@/components/CommuteList";
import { PlaceChips } from "@/components/PlaceChips";
import { PlacePicker } from "@/components/PlacePicker";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

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

type PlaceRef = string;

/**
 * The screen's whole state is two place refs in the URL.
 *
 * A ref is `me`, `place:<id>` for a saved place, or a plain place id. That makes a
 * commute a link -- "home from work" is a bookmark -- and it makes Back mean what it
 * looks like it means.
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

  const [position, setPosition] = useState<{ lat: number; lon: number } | null>(null);
  const [positionDenied, setPositionDenied] = useState(false);

  const needsPosition = fromRef === "me" || toRef === "me";
  useEffect(() => {
    if (!needsPosition || position || positionDenied) return;
    if (!navigator.geolocation) {
      setPositionDenied(true);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => setPosition({ lat: coords.latitude, lon: coords.longitude }),
      // Denied, unavailable or timed out all mean the same thing here: the chip has to
      // say so, because otherwise the screen simply never loads and never explains why.
      () => setPositionDenied(true),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, [needsPosition, position, positionDenied]);

  const asApiRef = (ref: PlaceRef | null): string | null => {
    if (!ref) return null;
    if (ref !== "me") return ref;
    return position ? `${position.lat},${position.lon}` : null;
  };
  const apiFrom = asApiRef(fromRef);
  const apiTo = asApiRef(toRef);
  const sameEnds = Boolean(fromRef && toRef && fromRef === toRef);

  /**
   * How much geometry to ask for, deliberately outside the query key.
   *
   * Selecting an option that has no drawn path has to refetch, but a key change would
   * empty the list to skeletons while the answer comes back -- the traveller would watch
   * the row they just tapped disappear. Same key, explicit refetch, rows stay put.
   */
  const paths = useRef<"recommended" | "all">("recommended");

  const commute = useQuery({
    queryKey: ["commute", apiFrom, apiTo],
    enabled: Boolean(apiFrom && apiTo) && !sameEnds,
    queryFn: ({ signal }) =>
      api.commute({ from: apiFrom!, to: apiTo!, paths: paths.current }, signal),
    staleTime: 30_000,
    // Only while the screen is actually being looked at: a phone in a pocket does not
    // need a plan every minute, and SL does not need the traffic.
    refetchInterval: () => (document.visibilityState === "visible" ? 60_000 : false),
    refetchOnWindowFocus: true,
  });

  const options = useMemo(() => commute.data?.options ?? [], [commute.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected: CommuteOption | null =
    options.find((o) => o.id === selectedId) ?? options[0] ?? null;

  // A new pair of places is a new list; keeping the old selection would draw a trip that
  // is no longer on screen.
  useEffect(() => {
    setSelectedId(null);
    paths.current = "recommended";
  }, [apiFrom, apiTo]);

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
  const picker = (location.state as { picker?: "from" | "to" } | null)?.picker ?? null;
  const openPicker = (end: "from" | "to") =>
    navigate({ pathname: location.pathname, search: location.search }, { state: { picker: end } });
  const closePicker = () => navigate(-1);

  const setEnds = (next: { from: PlaceRef | null; to: PlaceRef | null }, fromPicker: boolean) => {
    const search = new URLSearchParams(params);
    for (const key of ["from", "to"] as const) {
      const value = next[key];
      if (value) search.set(key, value);
      else search.delete(key);
    }
    if (fromPicker) {
      navigate(
        { pathname: location.pathname, search: `?${search.toString()}` },
        { replace: true, state: null },
      );
    } else {
      setParams(search, { replace: true });
    }
  };

  const swap = () => setEnds({ from: toRef, to: fromRef }, false);

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
        <PlaceChips
          fromLabel={fromLabel}
          toLabel={toLabel}
          onOpen={openPicker}
          onSwap={swap}
        />
      </div>

      <BottomSheet label="Resor härifrån" onHeightChange={setSheetHeight}>
        <div className="space-y-2 px-3 pb-4">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs text-[var(--color-muted)]">
              {commute.isError
                ? "Visar senaste svaret"
                : updatedSecondsAgo === null
                  ? "Hämtar resor"
                  : `Uppdaterad för ${updatedSecondsAgo} s sedan`}
            </p>
            {commute.data?.enumerated ? (
              <span className="text-xs text-[var(--color-muted)]">
                {options.length} resor
              </span>
            ) : null}
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

          {needsPosition && positionDenied ? (
            <p className="py-2 text-sm">
              Ingen åtkomst till din position. Välj en plats i stället.
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

          {commute.isPending && commute.fetchStatus === "fetching" ? (
            <ul className="space-y-2" aria-busy="true" aria-label="Söker resor">
              {[0, 1, 2].map((i) => (
                <li key={i}>
                  <Skeleton className="h-20 w-full" />
                </li>
              ))}
            </ul>
          ) : null}

          {options.length > 0 ? (
            <CommuteList
              options={options}
              selectedId={selected?.id ?? null}
              now={now}
              onSelect={select}
            />
          ) : null}

          {commute.isSuccess && options.length === 0 ? (
            <p className="py-2 text-sm">
              Ingen resa de närmaste timmarna. Prova en annan plats eller planera resan.
            </p>
          ) : null}

          {commute.data?.notices.map((notice) => (
            <p key={notice} className="text-xs text-[var(--color-muted)]">
              {notice}
            </p>
          ))}
        </div>
      </BottomSheet>

      {picker ? (
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
