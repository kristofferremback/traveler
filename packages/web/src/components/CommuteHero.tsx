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
export function leaveLabel(option: CommuteOption, now: number): { big: string; small: string | null } {
  if (option.status === "missed") return { big: `Gick ${formatTime(option.leaveAt)}`, small: null };
  const minutes = Math.round((new Date(option.leaveAt).getTime() - now) / 60_000);
  if (minutes <= 0) return { big: "Gå nu", small: null };
  if (minutes <= 15) return { big: `${minutes} min`, small: "tills du går" };
  return { big: `Gå ${formatTime(option.leaveAt)}`, small: null };
}

function minutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

/**
 * The selected option, at the size of the decision it is.
 *
 * The leave time is the headline; arrival, the ride and the walk are the line under it;
 * the legs, stop by stop, are the detail. Nothing here is a button: the choice is made
 * in the cards under it, and this is what was chosen.
 */
export function CommuteHero({ option, now }: { option: CommuteOption; now: number }) {
  const rides = option.journey.legs.filter((leg) => leg.mode !== "WALK");
  const first = rides[0];
  const boardName = first?.origin.name ?? option.origin.stop?.name ?? null;
  const boardAt = first ? (first.origin.expected ?? first.origin.scheduled) : option.boardAt;
  const alightName = rides.at(-1)?.destination.name ?? option.destination.stop?.name ?? null;
  const leave = leaveLabel(option, now);

  return (
    <section aria-label="Vald resa" className="px-1">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span
          className={cn(
            "text-[34px] font-bold leading-none tracking-tight tabular-nums",
            option.status === "missed" && "text-[var(--color-muted)]",
          )}
        >
          {leave.big}
        </span>
        <span className="text-[15px] text-[var(--color-muted)]">
          {leave.small ? `${leave.small} · ` : ""}framme {formatTime(option.arriveAt)}
        </span>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px]">
        {rides.map((leg) => (
          <LineBadge key={leg.index} line={leg.line} mode={leg.mode} className="text-sm" />
        ))}
        {boardName ? (
          <span>
            <span className="font-semibold tabular-nums">{formatTime(boardAt)}</span> från {boardName}
          </span>
        ) : null}
        {alightName ? (
          <>
            <ArrowRight className="size-3.5 text-[var(--color-muted)]" aria-hidden />
            <span>{alightName}</span>
          </>
        ) : null}
      </div>

      <p className="mt-1 text-[13px] text-[var(--color-muted)]">
        {option.transfers === 0
          ? "Inget byte"
          : `${option.transfers} byte${option.transfers > 1 ? "n" : ""}`}
        {` · ${minutes(option.walkSeconds)} min promenad`}
        {option.status === "recommended" ? (
          <span className="ml-1 font-semibold text-[var(--color-accent)]">· Rekommenderad</span>
        ) : null}
        {option.status === "tight" ? (
          <span className="ml-1 font-semibold text-[var(--color-warn)]">· Knappt</span>
        ) : null}
      </p>

      {/* Same vehicle, another stop: a variation on the choice, not a choice of its own. */}
      {option.alternatives.map((alternative) => (
        <p
          key={`${alternative.end}-${alternative.stop.stopPointId}`}
          className="mt-0.5 text-[13px] text-[var(--color-muted)]"
        >
          eller {alternative.stop.name}, {minutes(alternative.walkSeconds)} min promenad, framme{" "}
          {formatTime(alternative.arriveAt)}
        </p>
      ))}

      <div className="mt-3 border-t border-[var(--color-border)]">
        <JourneyLegs journey={option.journey} />
      </div>
    </section>
  );
}
