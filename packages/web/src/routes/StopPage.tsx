import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Navigation } from "lucide-react";
import { api } from "@/lib/api";
import { DepartureBoard } from "@/components/DepartureBoard";
import { ModeChips } from "@/components/LineBadge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function StopPage() {
  const { siteId } = useParams<{ siteId: string }>();
  const navigate = useNavigate();
  const id = Number(siteId);

  // Straight from the local catalog, so the header is filled before the first stream
  // frame arrives and stays correct if SL is unreachable.
  const site = useQuery({
    queryKey: ["site", id],
    enabled: Number.isInteger(id),
    queryFn: ({ signal }) => api.site(id, signal),
    staleTime: 60 * 60_000,
  });

  if (!Number.isInteger(id)) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <p className="text-sm text-[var(--color-muted)]">Okänd hållplats.</p>
        <Button variant="secondary" className="mt-3" onClick={() => navigate("/")}>
          Till sök
        </Button>
      </div>
    );
  }

  const place = site.data?.place;
  const name = place?.name;
  const gid = place?.id;
  const modes = place?.modes ?? [];

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-24">
      <header className="sticky top-0 z-20 -mx-4 flex items-center gap-2 bg-[var(--color-bg)]/95 px-4 pb-3 pt-3 backdrop-blur safe-top">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label="Tillbaka">
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          {name ? (
            <h1 className="truncate text-lg font-semibold">{name}</h1>
          ) : site.isError ? (
            <h1 className="truncate text-lg font-semibold">Okänd hållplats</h1>
          ) : (
            <Skeleton className="h-6 w-40" />
          )}
          {place?.locality ? (
            <p className="truncate text-xs text-[var(--color-muted)]">{place.locality}</p>
          ) : null}
          <ModeChips modes={modes} />
        </div>
        {/* The trip link needs the journey planner's id, not the departures id. Until
            the board reports it, the action is absent rather than broken. */}
        {gid ? (
          <Button variant="outline" size="sm" asChild>
            <Link to={`/plan?to=${encodeURIComponent(gid)}`}>
              <Navigation />
              Res hit
            </Link>
          </Button>
        ) : null}
      </header>

      <DepartureBoard siteId={id} siteName={name ?? undefined} />
    </div>
  );
}
