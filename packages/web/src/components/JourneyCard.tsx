import { useState } from "react";
import type { Journey, JourneyLeg } from "@traveler/shared";
import { ChevronDown, Footprints, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { dayLabel, formatDelay, formatDuration, formatTime, minutesUntil } from "@/lib/format";
import { MODE_LABEL } from "@/lib/modes";
import { LineBadge } from "./LineBadge";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";

function legDelay(leg: JourneyLeg): number | null {
  if (!leg.origin.scheduled || !leg.origin.expected) return null;
  return Math.round(
    (new Date(leg.origin.expected).getTime() - new Date(leg.origin.scheduled).getTime()) / 1000,
  );
}

/** Walking legs collapse to a single line; nobody needs a card for "walk 4 minutes". */
function LegRow({ leg }: { leg: JourneyLeg }) {
  const delay = formatDelay(legDelay(leg));

  if (leg.mode === "WALK") {
    return (
      <li className="flex items-center gap-3 py-2 text-sm text-[var(--color-muted)]">
        <Footprints className="size-4 shrink-0" aria-hidden />
        <span>
          Gå {formatDuration(leg.durationSeconds)}
          {leg.destination.name ? ` till ${leg.destination.name}` : ""}
        </span>
      </li>
    );
  }

  return (
    <li className="flex gap-3 py-2">
      <div className="flex flex-col items-center gap-1 pt-0.5">
        <LineBadge line={leg.line} mode={leg.mode} />
      </div>
      <div className="min-w-0 flex-1 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium tabular-nums">
            {formatTime(leg.origin.expected ?? leg.origin.scheduled)}
          </span>
          <span className="truncate">{leg.origin.name}</span>
          {leg.origin.platform ? (
            <Badge variant="outline">Läge {leg.origin.platform}</Badge>
          ) : null}
          {delay ? <Badge variant="warn">{delay}</Badge> : null}
        </div>

        {leg.towards ? (
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            Mot {leg.towards}
            {leg.intermediateStops.length > 0
              ? ` · ${leg.intermediateStops.length} hållplatser`
              : ""}
          </p>
        ) : null}

        <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium tabular-nums">
            {formatTime(leg.destination.expected ?? leg.destination.scheduled)}
          </span>
          <span className="truncate">{leg.destination.name}</span>
          {leg.destination.platform ? (
            <Badge variant="outline">Läge {leg.destination.platform}</Badge>
          ) : null}
        </div>

        {leg.notes.map((note) => (
          <p key={note} className="mt-1 flex gap-1.5 text-xs text-[var(--color-warn)]">
            <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
            {note}
          </p>
        ))}
      </div>
    </li>
  );
}

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
          <ul className="divide-y divide-[var(--color-border)]">
            {journey.legs.map((leg) => (
              <LegRow key={leg.index} leg={leg} />
            ))}
          </ul>
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
