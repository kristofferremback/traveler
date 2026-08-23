import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { KIND_ICON, KIND_LABEL } from "@/lib/savedPlaces";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** The places you keep, in the order you put them in. */
export function PlacesPage() {
  const places = useQuery({
    queryKey: ["places"],
    queryFn: ({ signal }) => api.places.list(signal),
  });

  const rows = places.data?.places ?? [];

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 pb-24">
      <header className="flex items-center justify-between gap-2 pb-1 pt-3 safe-top">
        <h1 className="text-lg font-semibold">Platser</h1>
        <Button asChild size="sm">
          <Link to="/places/new">
            <Plus aria-hidden />
            Lägg till plats
          </Link>
        </Button>
      </header>

      {places.isPending ? (
        <ul className="space-y-2" aria-busy="true" aria-label="Hämtar platser">
          {[0, 1].map((i) => (
            <li key={i}>
              <Skeleton className="h-16 w-full" />
            </li>
          ))}
        </ul>
      ) : null}

      {places.isError ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {places.error instanceof ApiError
            ? places.error.message
            : "Platserna kunde inte hämtas."}
        </p>
      ) : null}

      {places.isSuccess && rows.length === 0 ? (
        <p className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted)]">
          Spara hem, jobbet eller vilken plats som helst, så räknar Traveler ut vad du
          når till fots därifrån.
        </p>
      ) : null}

      <ul className="space-y-2">
        {rows.map((place) => {
          const Icon = KIND_ICON[place.kind];
          return (
            <li key={place.id}>
              <Link
                to={`/places/${place.id}`}
                className="flex min-h-14 items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
              >
                <Icon className="size-5 shrink-0 text-[var(--color-muted)]" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{place.label}</span>
                  <span className="block truncate text-xs text-[var(--color-muted)]">
                    {place.name} · {KIND_LABEL[place.kind]}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-[var(--color-muted)]" aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
