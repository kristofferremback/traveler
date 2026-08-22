import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Place } from "@traveler/shared";
import { ArrowUpDown, Clock, Map as MapIcon, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { instantToLocalInput, localInputToInstant } from "@/lib/format";
import { PlaceSearchField } from "@/components/PlaceSearchField";
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
  const showTime = Boolean(when);

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

  const update = useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(params);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      // Replace rather than push: adjusting a field is refining one search, not
      // starting another, and each keystroke should not become a Back step.
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const chooseFrom = useCallback(
    (place: Place | null) => {
      setFrom(place);
      update({ from: place?.id ?? null });
    },
    [update],
  );

  const chooseTo = useCallback(
    (place: Place | null) => {
      setTo(place);
      update({ to: place?.id ?? null });
    },
    [update],
  );

  const swap = () => {
    setFrom(to);
    setTo(from);
    update({ from: to?.id ?? null, to: from?.id ?? null });
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
    <div className="mx-auto w-full max-w-2xl px-4 pb-24">
      <div className="sticky top-0 z-20 -mx-4 bg-[var(--color-bg)]/95 px-4 pb-3 pt-3 backdrop-blur safe-top">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1 space-y-2">
            <PlaceSearchField
              label="Från"
              value={from}
              onChange={chooseFrom}
              placeholder="Hållplats, adress eller plats"
              allowCurrentPosition
            />
            <PlaceSearchField
              label="Till"
              value={to}
              onChange={chooseTo}
              placeholder="Hållplats, adress eller plats"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={swap}
            disabled={!from && !to}
            aria-label="Byt plats på från och till"
            className="mb-0.5"
          >
            <ArrowUpDown />
          </Button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {showTime ? (
            <>
              <label className="sr-only" htmlFor="departure-time">
                {arriveBy ? "Framme senast" : "Avgång tidigast"}
              </label>
              <input
                id="departure-time"
                type="datetime-local"
                value={instantToLocalInput(when!)}
                onChange={(e) => {
                  const instant = localInputToInstant(e.target.value);
                  if (instant) update({ when: instant });
                }}
                className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm"
              />
              <Button
                type="button"
                variant={arriveBy ? "default" : "outline"}
                size="sm"
                onClick={() => update({ arriveBy: arriveBy ? null : "1" })}
                aria-pressed={arriveBy}
              >
                Framme senast
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => update({ when: null, arriveBy: null })}
              >
                <X />
                Nu
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => update({ when: new Date().toISOString() })}
            >
              <Clock />
              Välj tid
            </Button>
          )}

          {journeys.length > 0 ? (
            <Button
              type="button"
              variant={showMap ? "default" : "outline"}
              size="sm"
              onClick={() => setShowMap((v) => !v)}
              aria-pressed={showMap}
            >
              <MapIcon />
              Karta
            </Button>
          ) : null}
        </div>
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
    </div>
  );
}
