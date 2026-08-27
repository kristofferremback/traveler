import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Place } from "@traveler/shared";
import { Map as MapIcon } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useOverlay } from "@/lib/overlay";
import { PlaceSearch, type PlaceChoice } from "@/components/PlaceSearch";
import { TimePicker, type PlanTime } from "@/components/TimePicker";
import { TripControl } from "@/components/TripControl";
import { JourneyCard } from "@/components/JourneyCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * MapLibre and the pmtiles reader are about a megabyte, and most searches are answered
 * by reading the times off the first card. The map loads when it is asked for.
 */
const TransitMap = lazy(() =>
  import("@/components/TransitMap").then((m) => ({ default: m.TransitMap })),
);

/**
 * Any trip between any two places, as opposed to the commute screen's two saved ends.
 *
 * The question is the same question, so it is asked with the same control in the same
 * corner of the screen: Från, swap, Till, and the time under them. Only the answer
 * differs -- SL's own journeys rather than our walking engine's options.
 *
 * The whole query lives in the URL, so a planned trip is a link. Back and forward move
 * through searches the way they move through pages, and reloading keeps the result.
 */
export function PlanPage() {
  const [params, setParams] = useSearchParams();
  const [from, setFrom] = useState<Place | null>(null);
  const [to, setTo] = useState<Place | null>(null);
  const [showMap, setShowMap] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const fromId = params.get("from");
  const toId = params.get("to");
  const when = params.get("when");
  const arriveBy = params.get("arriveBy") === "1";
  const time: PlanTime = when ? { when, arriveBy } : null;

  const savedPlaces = useQuery({
    queryKey: ["places"],
    queryFn: ({ signal }) => api.places.list(signal),
    staleTime: 60_000,
  });
  const saved = useMemo(
    () => [...(savedPlaces.data?.places ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [savedPlaces.data],
  );

  /**
   * Keep the fields and the URL in step, in both directions.
   *
   * The URL is the source of truth, so a parameter disappearing has to clear the field
   * as well as a parameter appearing has to fill it. Handling only the second left
   * Back showing a stop that the current URL no longer mentions, and then searching
   * with it.
   */
  useEffect(() => {
    if (!fromId) {
      setFrom(null);
      return;
    }
    if (from?.id === fromId) return;
    let cancelled = false;
    void api
      .resolvePlace(fromId)
      .then(({ place }) => !cancelled && setFrom(place))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fromId, from?.id]);

  useEffect(() => {
    if (!toId) {
      setTo(null);
      return;
    }
    if (to?.id === toId) return;
    let cancelled = false;
    void api
      .resolvePlace(toId)
      .then(({ place }) => !cancelled && setTo(place))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [toId, to?.id]);

  const merge = useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(params);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      return next;
    },
    [params],
  );

  // Replace rather than push: adjusting one end is refining one search, not starting
  // another, and each adjustment should not become a Back step.
  const update = useCallback(
    (changes: Record<string, string | null>) => setParams(merge(changes), { replace: true }),
    [merge, setParams],
  );

  const { open: picker, show: openPicker, close: closePicker, settle } =
    useOverlay<"from" | "to" | "time">();

  /** An answer from an overlay: the same change as `update`, and the overlay closes. */
  const answer = useCallback(
    (changes: Record<string, string | null>) => settle(merge(changes)),
    [merge, settle],
  );

  // The two places are swapped here as well as in the URL: the effects above would
  // otherwise re-resolve both ids over the network to learn what this already knows.
  const swap = () => {
    const previous = from;
    setFrom(to);
    setTo(previous);
    update({ from: toId, to: fromId });
  };

  const query = useQuery({
    queryKey: ["journeys", fromId, toId, when, arriveBy],
    enabled: Boolean(fromId && toId),
    queryFn: ({ signal }) =>
      api.journeys(
        {
          from: fromId!,
          to: toId!,
          when: when ?? undefined,
          arriveBy,
          results: 3,
        },
        signal,
      ),
    // Realtime estimates go stale quickly; a minute-old plan is still worth showing
    // while the refetch runs.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const journeys = query.data?.journeys ?? [];
  const selectedJourney = useMemo(
    () => journeys.find((j) => j.id === selected) ?? journeys[0] ?? null,
    [journeys, selected],
  );

  return (
    <div className="mx-auto w-full max-w-2xl px-3 pb-24">
      <div className="sticky top-0 z-20 -mx-3 bg-[var(--color-bg)]/95 px-3 pb-3 pt-1 backdrop-blur safe-top">
        <TripControl
          fromLabel={from?.name ?? "Välj plats"}
          toLabel={to?.name ?? "Välj plats"}
          time={time}
          onOpen={openPicker}
          onSwap={swap}
          trailing={
            journeys.length > 0 ? (
              <Button
                type="button"
                variant={showMap ? "default" : "outline"}
                size="sm"
                onClick={() => setShowMap((v) => !v)}
                aria-pressed={showMap}
                className="rounded-full"
              >
                <MapIcon />
                Karta
              </Button>
            ) : null
          }
        />
      </div>

      {showMap && selectedJourney ? (
        <div className="relative mb-3 h-64 overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)]">
          <Suspense fallback={<Skeleton className="size-full rounded-none" />}>
            <TransitMap journey={selectedJourney} className="relative size-full" />
          </Suspense>
        </div>
      ) : null}

      {!fromId || !toId ? (
        <p className="mt-8 text-center text-sm text-[var(--color-muted)]">
          Välj var du börjar och var du ska.
        </p>
      ) : null}

      {query.isPending && fromId && toId ? (
        <ul className="space-y-2" aria-busy="true" aria-label="Söker resor">
          {[0, 1, 2].map((i) => (
            <li key={i}>
              <Skeleton className="h-28 w-full" />
            </li>
          ))}
        </ul>
      ) : null}

      {query.isError ? (
        <div className="rounded-[var(--radius-card)] border border-[var(--color-danger)] p-4">
          <p className="text-sm">
            {query.error instanceof ApiError
              ? query.error.message
              : "Kunde inte hämta resor."}
          </p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => query.refetch()}>
            Försök igen
          </Button>
        </div>
      ) : null}

      {query.isSuccess && journeys.length === 0 ? (
        <p className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted)]">
          Ingen resa hittades. Prova en annan tid.
        </p>
      ) : null}

      <ul className="space-y-2">
        {journeys.map((journey) => (
          <li key={journey.id}>
            <JourneyCard
              journey={journey}
              selected={selectedJourney?.id === journey.id}
              onSelect={() => setSelected(journey.id)}
            />
          </li>
        ))}
      </ul>

      {query.data?.notices.map((notice) => (
        <p key={notice} className="mt-3 text-xs text-[var(--color-muted)]">
          {notice}
        </p>
      ))}

      {picker === "time" ? (
        <TimePicker
          time={time}
          onPick={(next) =>
            answer({ when: next?.when ?? null, arriveBy: next?.arriveBy ? "1" : null })
          }
          onClose={closePicker}
        />
      ) : null}

      {picker === "from" || picker === "to" ? (
        <PlaceSearch
          title={picker === "from" ? "Var börjar du?" : "Vart ska du?"}
          saved={saved}
          /* An address rather than the live ref the commute screen keeps: this screen
             plans one trip from one point, and the URL has to name it. */
          currentPosition="address"
          onPick={(choice) => answer({ [picker]: placeId(choice) })}
          onClose={closePicker}
        />
      ) : null}
    </div>
  );
}

/**
 * A choice from the search screen as a place id for the URL.
 *
 * A saved place stands for the place under it here rather than for the label: this
 * screen has no "Hem", only the stop Hem points at, and the planner speaks in ids.
 */
function placeId(choice: PlaceChoice): string | null {
  if (choice.kind === "saved") return choice.place.ref;
  if (choice.kind === "place") return choice.place.id;
  return null;
}
