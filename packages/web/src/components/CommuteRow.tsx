import type { CommuteOption } from "@traveler/shared";
import { ArrowRight } from "lucide-react";
import { formatTime } from "@/lib/format";
import { JourneyLegs } from "./JourneyLegs";
import { LineBadge } from "./LineBadge";
import { cn } from "@/lib/utils";

/**
 * When to leave, in the words the moment deserves.
 *
 * Minutes while they still mean something to a person standing up to go, a clock time
 * beyond that, and the past tense for a departure that is already gone -- a missed row
 * that said "Gå nu" would be a lie with a countdown on it.
 */
function leaveLabel(option: CommuteOption, now: number): string {
  if (option.status === "missed") return `Gick ${formatTime(option.leaveAt)}`;
  const minutes = Math.round((new Date(option.leaveAt).getTime() - now) / 60_000);
  if (minutes <= 0) return "Gå nu";
  if (minutes <= 15) return `Gå om ${minutes} min`;
  return `Gå ${formatTime(option.leaveAt)}`;
}

function minutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

export function CommuteRow({
  option,
  selected,
  now,
  onSelect,
}: {
  option: CommuteOption;
  selected: boolean;
  /** Ticks every ten seconds so the countdown is never a minute behind the platform. */
  now: number;
  onSelect: () => void;
}) {
  const rides = option.journey.legs.filter((leg) => leg.mode !== "WALK");
  const boardName = rides[0]?.origin.name ?? option.origin.stop?.name ?? null;
  const alightName = rides.at(-1)?.destination.name ?? option.destination.stop?.name ?? null;
  const missed = option.status === "missed";

  return (
    <li>
      <div
        className={cn(
          "rounded-[var(--radius-card)] border",
          option.status === "recommended"
            ? "border-[var(--color-accent)]"
            : "border-[var(--color-border)]",
          selected && option.status !== "recommended" && "border-[var(--color-fg)]",
          missed && "opacity-60",
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          aria-expanded={selected}
          className="w-full px-3 py-2.5 text-left"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-base font-semibold">{leaveLabel(option, now)}</span>
            <span className="shrink-0 text-sm tabular-nums text-[var(--color-muted)]">
              Framme {formatTime(option.arriveAt)}
            </span>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
            {rides.map((leg) => (
              <LineBadge key={leg.index} line={leg.line} mode={leg.mode} />
            ))}
            {boardName ? <span>från {boardName}</span> : null}
            {alightName ? (
              <>
                <ArrowRight className="size-3 text-[var(--color-muted)]" aria-hidden />
                <span>{alightName}</span>
              </>
            ) : null}
          </div>

          <p className="mt-1 text-xs text-[var(--color-muted)]">
            {option.transfers === 0
              ? "Inget byte"
              : `${option.transfers} byte${option.transfers > 1 ? "n" : ""}`}
            {` · ${minutes(option.walkSeconds)} min promenad`}
            {option.status === "recommended" ? (
              <span className="ml-1 font-medium text-[var(--color-accent)]">
                · Rekommenderad
              </span>
            ) : null}
            {option.status === "tight" ? (
              <span className="ml-1 font-medium text-[var(--color-warn)]">· Knappt</span>
            ) : null}
          </p>

          {/* Same vehicle, another stop. Second line and muted, because it is a variation
              on the row above it rather than a choice of its own. */}
          {option.alternatives.map((alternative) => (
            <p
              key={`${alternative.end}-${alternative.stop.stopPointId}`}
              className="mt-1 text-xs text-[var(--color-muted)]"
            >
              eller {alternative.stop.name}, {minutes(alternative.walkSeconds)} min promenad,
              framme {formatTime(alternative.arriveAt)}
            </p>
          ))}
        </button>

        {selected ? (
          <div className="border-t border-[var(--color-border)] px-3 pb-2">
            <JourneyLegs journey={option.journey} />
          </div>
        ) : null}
      </div>
    </li>
  );
}
