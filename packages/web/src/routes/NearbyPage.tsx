import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LocateFixed, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { formatDistance } from "@/lib/format";
import { ModeChips } from "@/components/LineBadge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type Position = { lat: number; lon: number };

/** How far this page looks. Named so the empty state cannot drift away from it. */
const RADIUS_M = 1200;

export function NearbyPage() {
  const [position, setPosition] = useState<Position | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  const locate = () => {
    if (!navigator.geolocation) {
      setGeoError("Enheten delar ingen position.");
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setPosition({ lat: coords.latitude, lon: coords.longitude });
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? "Positionen är blockerad. Tillåt platsåtkomst för att se hållplatser nära dig."
            : "Kunde inte hämta din position.",
        );
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
    );
  };

  // Asked for on arrival, because that is the entire point of this page. A denial is
  // reported once and leaves a button rather than re-prompting on every render.
  useEffect(locate, []);

  const stops = useQuery({
    queryKey: ["nearby", position?.lat, position?.lon],
    enabled: position !== null,
    queryFn: ({ signal }) =>
      api.nearby({ lat: position!.lat, lon: position!.lon, radius: RADIUS_M, limit: 25 }, signal),
    staleTime: 60_000,
  });

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-24">
      <header className="flex items-center justify-between gap-2 pb-3 pt-3 safe-top">
        <h1 className="text-lg font-semibold">Nära dig</h1>
        <Button variant="outline" size="sm" onClick={locate} disabled={locating}>
          {locating ? <Loader2 className="animate-spin" /> : <LocateFixed />}
          Uppdatera
        </Button>
      </header>

      {geoError ? (
        <p className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4 text-sm text-[var(--color-muted)]">
          {geoError}
        </p>
      ) : null}

      {stops.isPending && position ? (
        <ul className="space-y-2" aria-busy="true" aria-label="Hämtar hållplatser">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li key={i}>
              <Skeleton className="h-16 w-full" />
            </li>
          ))}
        </ul>
      ) : null}

      {stops.data && stops.data.places.length === 0 ? (
        <p className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted)]">
          Inga hållplatser inom {formatDistance(RADIUS_M)}.
        </p>
      ) : null}

      <ul className="space-y-2">
        {stops.data?.places.map((place) => (
          <li key={place.id}>
            <Card>
              <Link
                to={`/stop/${place.siteId}`}
                className="flex min-h-16 items-center gap-3 p-4"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{place.name}</span>
                  {place.locality ? (
                    <span className="block truncate text-xs text-[var(--color-muted)]">
                      {place.locality}
                    </span>
                  ) : null}
                </span>
                <ModeChips modes={place.modes} />
                <span className="text-xs tabular-nums text-[var(--color-muted)]">
                  {formatDistance(place.distanceMetres)}
                </span>
              </Link>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
