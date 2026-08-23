import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { formatDistance } from "@/lib/format";
import { KIND_ICON, KIND_LABEL } from "@/lib/savedPlaces";
import { LineBadge } from "@/components/LineBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

/** Same reason as the plan page: the map is a megabyte and not every visit wants it. */
const TransitMap = lazy(() =>
  import("@/components/TransitMap").then((m) => ({ default: m.TransitMap })),
);

function minutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

/**
 * One saved place: what it is, what you can walk to from it, and how far each of those
 * is in both directions -- the walk home is the same street with the hill the other way
 * round, and that difference is the whole reason the neighbourhood is routed at all.
 */
export function PlacePage() {
  const params = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const id = Number(params.id);

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);

  const place = useQuery({
    queryKey: ["place", id],
    enabled: Number.isInteger(id),
    queryFn: ({ signal }) => api.places.get(id, signal),
  });

  /**
   * The first read of a neighbourhood computes it, which takes a few seconds of
   * rate-limited street routing. The request simply stays open until it is done, so
   * there is nothing to poll for -- the page shows what it is waiting for instead.
   */
  const hood = useQuery({
    queryKey: ["place-neighbourhood", id],
    enabled: Number.isInteger(id) && place.isSuccess,
    queryFn: ({ signal }) => api.places.neighbourhood(id, { isochrones: true }, signal),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming]);

  const rename = useMutation({
    mutationFn: (label: string) => api.places.patch(id, { label }),
    onSuccess: async ({ place: saved }) => {
      queryClient.setQueryData(["place", id], { place: saved });
      await queryClient.invalidateQueries({ queryKey: ["places"] });
      setRenaming(false);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.places.delete(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["places"] });
      navigate("/places", { replace: true });
    },
  });

  const saved = place.data?.place;
  const stops = [...(hood.data?.stops ?? [])].sort((a, b) => a.secondsTo - b.secondsTo);
  const Icon = saved ? KIND_ICON[saved.kind] : null;

  function commitRename() {
    const next = draft.trim();
    if (!next || next === saved?.label) {
      setRenaming(false);
      return;
    }
    rename.mutate(next);
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 pb-24">
      <header className="flex items-center gap-1 pb-1 pt-3 safe-top">
        <Button asChild variant="ghost" size="icon">
          <Link to="/places" aria-label="Tillbaka till platser">
            <ChevronLeft />
          </Link>
        </Button>
        {place.isPending ? (
          <Skeleton className="h-6 w-40" />
        ) : renaming ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <label htmlFor="place-label" className="sr-only">
              Namn
            </label>
            <Input
              id="place-label"
              ref={renameRef}
              value={draft}
              maxLength={40}
              autoComplete="off"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setRenaming(false);
                }
              }}
            />
            <Button size="sm" onClick={commitRename} disabled={rename.isPending}>
              Spara
            </Button>
          </div>
        ) : (
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{saved?.label}</h1>
        )}
      </header>

      {place.isError ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {place.error instanceof ApiError ? place.error.message : "Platsen kunde inte hämtas."}
        </p>
      ) : null}

      {saved ? (
        <>
          <p className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
            {Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null}
            <span className="truncate">
              {saved.name} · {KIND_LABEL[saved.kind]}
            </span>
          </p>

          <div className="flex flex-wrap gap-2">
            {renaming ? null : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDraft(saved.label);
                  setRenaming(true);
                }}
              >
                Byt namn
              </Button>
            )}
            {/* Two buttons rather than window.confirm: a modal dialog from the browser
                is unreadable on a phone and cannot be styled or tested. */}
            {confirmingDelete ? (
              <>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => remove.mutate()}
                  disabled={remove.isPending}
                >
                  Ta bort {saved.label}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
                  Avbryt
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setConfirmingDelete(true)}>
                Ta bort
              </Button>
            )}
          </div>

          {rename.isError || remove.isError ? (
            <p role="alert" className="text-sm text-[var(--color-danger)]">
              {(rename.error ?? remove.error) instanceof ApiError
                ? (rename.error ?? remove.error)!.message
                : "Ändringen kunde inte sparas."}
            </p>
          ) : null}

          <div className="relative h-64 overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)]">
            <Suspense fallback={<Skeleton className="size-full rounded-none" />}>
              <TransitMap
                neighbourhood={hood.data ?? null}
                className="relative size-full"
              />
            </Suspense>
          </div>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Hållplatser att gå till</h2>

            {hood.isPending ? (
              <>
                <p className="text-xs text-[var(--color-muted)]">
                  Räknar ut promenadvägarna härifrån. Det tar några sekunder första gången.
                </p>
                <ul className="space-y-2" aria-busy="true" aria-label="Räknar ut promenadvägar">
                  {[0, 1, 2, 3].map((i) => (
                    <li key={i}>
                      <Skeleton className="h-12 w-full" />
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {hood.isError ? (
              <p role="alert" className="text-sm text-[var(--color-danger)]">
                {hood.error instanceof ApiError
                  ? hood.error.message
                  : "Promenadvägarna kunde inte räknas ut."}
              </p>
            ) : null}

            {hood.isSuccess && stops.length === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">
                Ingen hållplats inom din maxpromenad. Höj den under Mer.
              </p>
            ) : null}

            <ul className="divide-y divide-[var(--color-border)]">
              {stops.map((stop) => (
                <li
                  key={`${stop.stopPointId}:${stop.mode}`}
                  className="flex min-h-12 items-center gap-3 py-2"
                >
                  <LineBadge mode={stop.mode} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{stop.name}</span>
                    <span className="block text-xs text-[var(--color-muted)]">
                      {minutes(stop.secondsTo)} min dit · {minutes(stop.secondsFrom)} min hem
                    </span>
                  </span>
                  <span className="text-xs text-[var(--color-muted)]">
                    {formatDistance(stop.metres)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}
