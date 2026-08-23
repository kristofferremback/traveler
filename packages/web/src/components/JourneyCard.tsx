import { useState } from "react";
import type { Journey } from "@traveler/shared";
import { ChevronDown, Footprints } from "lucide-react";
import { Link } from "react-router-dom";
import { dayLabel, formatDuration, formatTime, minutesUntil } from "@/lib/format";
import { MODE_LABEL } from "@/lib/modes";
import { JourneyLegs } from "./JourneyLegs";
import { LineBadge } from "./LineBadge";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";

export function JourneyCard({
  journey,
  selected,
  onSelect,
}: {
  journey: Journey;
  selected: boolean;
  onSelect: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const departsIn = minutesUntil(journey.departure);
  const day = dayLabel(journey.departure);
  const transitLegs = journey.legs.filter((l) => l.mode !== "WALK");

  return (
    <Card
      className={cn(
        "overflow-hidden transition-colors",
        selected && "border-[var(--color-accent)]",
      )}
    >
      <button
        type="button"
        onClick={() => {
          onSelect();
          setExpanded((v) => !v);
        }}
        aria-expanded={expanded}
        className="flex w-full items-start gap-3 p-4 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-semibold tabular-nums">
              {formatTime(journey.departure)}
            </span>
            <span className="text-[var(--color-muted)]" aria-hidden>
              →
            </span>
            <span className="text-lg font-semibold tabular-nums">
              {formatTime(journey.arrival)}
            </span>
            {day ? <Badge variant="outline">{day}</Badge> : null}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {transitLegs.map((leg) => (
              <LineBadge key={leg.index} line={leg.line} mode={leg.mode} />
            ))}
            {journey.walkSeconds > 0 ? (
              <span className="inline-flex items-center gap-1 text-xs text-[var(--color-muted)]">
                <Footprints className="size-3.5" aria-hidden />
                {formatDuration(journey.walkSeconds)}
                <span className="sr-only">gång totalt</span>
              </span>
            ) : null}
          </div>

          <p className="mt-2 text-xs text-[var(--color-muted)]">
            {formatDuration(journey.durationSeconds)}
            {" · "}
            {journey.interchanges === 0
              ? "direkt"
              : `${journey.interchanges} byte${journey.interchanges > 1 ? "n" : ""}`}
            {departsIn !== null && departsIn >= 0 && departsIn < 60
              ? ` · om ${departsIn} min`
              : ""}
          </p>
        </div>

        <ChevronDown
          className={cn(
            "mt-1 size-5 shrink-0 text-[var(--color-muted)] transition-transform",
            expanded && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {expanded ? (
        <div className="border-t border-[var(--color-border)] px-4 pb-3">
          <JourneyLegs journey={journey} />
          {journey.legs[0]?.origin.siteId ? (
            <Link
              to={`/stop/${journey.legs[0].origin.siteId}`}
              className="mt-2 inline-block text-xs text-[var(--color-accent)] underline underline-offset-2"
            >
              Alla avgångar från {journey.legs[0].origin.name}
            </Link>
          ) : null}
        </div>
      ) : (
        <span className="sr-only">
          {transitLegs.map((l) => `${MODE_LABEL[l.mode]} ${l.line?.designation ?? ""}`).join(", ")}
        </span>
      )}
    </Card>
  );
}
