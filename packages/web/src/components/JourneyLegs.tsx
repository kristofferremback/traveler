import type { Journey, JourneyLeg } from "@traveler/shared";
import { Footprints, TriangleAlert } from "lucide-react";
import { formatDelay, formatDuration, formatTime } from "@/lib/format";
import { LineBadge } from "./LineBadge";
import { Badge } from "./ui/badge";

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

/**
 * The legs of a journey, stop by stop.
 *
 * Shared by the planner's card and the commute sheet: the same trip described two ways
 * would be two sets of times to keep in step, and the one that drifted would be wrong on
 * a platform.
 */
export function JourneyLegs({ journey }: { journey: Journey }) {
  return (
    <ul className="divide-y divide-[var(--color-border)]">
      {journey.legs.map((leg) => (
        <LegRow key={leg.index} leg={leg} />
      ))}
    </ul>
  );
}
