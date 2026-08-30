import { useEffect, useMemo, useState } from "react";
import type { DeparturesResponse } from "@traveler/shared";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { streams } from "@/lib/api";
import { useStream } from "@/hooks/useStream";
import { formatDelay, formatTime } from "@/lib/format";
import { MODE_FILTERS, MODE_LABEL, type ModeFilter } from "@/lib/modes";
import { LineBadge } from "./LineBadge";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import { cn } from "@/lib/utils";

export function DepartureBoard({ siteId, siteName }: { siteId: number; siteName?: string }) {
  // The same list the trip screens filter by, so "Båt" means the same thing on a
  // timetable as it does in a search -- and covers the ferry berths, which the board's
  // own copy of this list used to leave off the board entirely.
  const [mode, setMode] = useState<ModeFilter | null>(null);

  // The stream is deliberately unfiltered and the mode filter is applied here.
  //
  // Asking the server for one mode would make the payload the only evidence of which
  // modes exist, so picking "Buss" would leave a board containing only buses, collapse
  // the tab list to Alla+Buss, and on a bus-only result hide the tabs altogether with
  // no way back. Filtering locally also avoids reconnecting the stream on every tap.
  const url = useMemo(() => streams.departures(siteId, { forecast: 60 }), [siteId]);
  const { data, error, connected, updatedAt } = useStream<DeparturesResponse>(url, "departures");

  // Only offer a filter for modes this stop actually has. A bus-only stop showing a
  // "Tunnelbana" tab that always returns nothing is worse than no tabs at all.
  // The active filter always stays in the list even when this poll returned nothing
  // for it, so a quiet stretch on one mode never removes the way back to "Alla".
  const availableModes = useMemo(() => {
    const present = new Set(data?.departures.map((d) => d.line.mode) ?? []);
    return MODE_FILTERS.filter((f) => f === mode || f.modes.some((m) => present.has(m)));
  }, [data, mode]);

  const departures = useMemo(
    () => (data?.departures ?? []).filter((d) => !mode || mode.modes.includes(d.line.mode)),
    [data, mode],
  );

  // Liveness has to be re-evaluated on a clock, not only when something rerenders. A
  // stream that stops delivering produces no renders at all, which is exactly the case
  // this warning exists for.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  const stale = updatedAt !== null && now - updatedAt > 60_000;

  return (
    <section aria-label={`Avgångar från ${siteName ?? data?.siteName ?? "hållplats"}`}>
      {availableModes.length > 1 || mode !== null ? (
        <div
          role="tablist"
          aria-label="Filtrera färdmedel"
          className="mb-3 flex gap-1.5 overflow-x-auto pb-1"
        >
          {[null, ...availableModes].map((filter) => (
            <button
              key={filter?.label ?? "alla"}
              role="tab"
              aria-selected={mode === filter}
              onClick={() => setMode(filter)}
              className={cn(
                "min-h-11 min-w-20 shrink-0 rounded-full border px-4 text-xs",
                mode === filter
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-bg)]"
                  : "border-[var(--color-border)] text-[var(--color-muted)]",
              )}
            >
              {filter?.label ?? "Alla"}
            </button>
          ))}
        </div>
      ) : null}

      {data?.deviations.map((deviation) => (
        <p
          key={deviation.id}
          className="mb-2 flex gap-2 rounded-lg bg-[var(--color-warn)]/10 p-3 text-xs text-[var(--color-warn)]"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{deviation.details || deviation.header}</span>
        </p>
      ))}

      {!connected && !data ? (
        <ul className="space-y-2" aria-busy="true" aria-label="Hämtar avgångar">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i}>
              <Skeleton className="h-14 w-full" />
            </li>
          ))}
        </ul>
      ) : null}

      {data && departures.length === 0 ? (
        <p className="rounded-lg border border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted)]">
          {mode === null
            ? "Inga avgångar den närmaste timmen."
            : "Inga avgångar med det färdmedlet den närmaste timmen."}
        </p>
      ) : null}

      <ul className="divide-y divide-[var(--color-border)]">
        {departures.map((departure) => {
          const delay = formatDelay(departure.delaySeconds);
          const cancelled = departure.state === "CANCELLED";
          return (
            <li key={departure.key} className="flex items-center gap-3 py-2.5">
              <LineBadge line={departure.line} />

              <div className="min-w-0 flex-1">
                <p className={cn("truncate text-sm", cancelled && "line-through opacity-60")}>
                  {departure.destination}
                </p>
                <p className="text-xs text-[var(--color-muted)]">
                  {formatTime(departure.scheduled)}
                  {departure.platform ? ` · läge ${departure.platform}` : ""}
                  {departure.stopAreaName && departure.stopAreaName !== data?.siteName
                    ? ` · ${departure.stopAreaName}`
                    : ""}
                </p>
              </div>

              {cancelled ? (
                <Badge variant="danger">Inställd</Badge>
              ) : (
                <div className="text-right">
                  <span className="block text-sm font-semibold tabular-nums">
                    {departure.display}
                  </span>
                  {delay ? (
                    <span className="text-xs text-[var(--color-warn)]">{delay}</span>
                  ) : null}
                </div>
              )}
              <span className="sr-only">
                {MODE_LABEL[departure.line.mode]} mot {departure.destination}, {departure.display}
                {delay ? `, ${delay} försenad` : ""}
                {cancelled ? ", inställd" : ""}
              </span>
            </li>
          );
        })}
      </ul>

      {/* Only shown when something is actually wrong. Success is silent because the
          times on screen already say the stream is alive. */}
      {error || stale ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-[var(--color-muted)]">
          <RefreshCw className="size-3" aria-hidden />
          {error ?? "Uppdateras inte just nu."}
          {updatedAt ? ` Senast ${formatTime(new Date(updatedAt).toISOString())}.` : ""}
        </p>
      ) : null}
    </section>
  );
}
