import type { ReactNode } from "react";
import type { CommuteOption, JourneyLeg } from "@traveler/shared";
import { formatTime } from "@/lib/format";
import { leaveLabel, liveStatus } from "@/lib/trips";
import { LineBadge } from "./LineBadge";
import { cn } from "@/lib/utils";

/** The ride as one line: boarding time and line for every leg, then where it lands. */
export function Ride({ legs, className }: { legs: JourneyLeg[]; className?: string }) {
  const rides = legs.filter((leg) => leg.mode !== "WALK");
  const last = rides.at(-1);
  return (
    <span className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13.5px] tabular-nums", className)}>
      {rides.map((leg, i) => (
        <span key={leg.index} className="contents">
          {i > 0 ? <span className="text-[var(--color-muted)]" aria-hidden>·</span> : null}
          <span className="font-semibold">{formatTime(leg.origin.expected ?? leg.origin.scheduled)}</span>
          <LineBadge line={leg.line} mode={leg.mode} className="min-h-5 text-[11px]" />
        </span>
      ))}
      {last ? (
        <span className="whitespace-nowrap text-[var(--color-muted)]">
          <span aria-hidden>→ </span>
          <span className="sr-only">till {last.destination.name} </span>
          {formatTime(last.destination.expected ?? last.destination.scheduled)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * One trip as one row: when to leave, the ride leg by leg, when you land.
 *
 * Rows, not cards: the engine answers with dozens of trips and the question is always
 * "which of these", which is answered by scanning one column. The columns are fixed so
 * the times line up down the list.
 */
export function TripRow({
  option,
  now,
  selected,
  onOpen,
  arriveLabel,
  note,
  className,
}: {
  option: CommuteOption;
  now: number;
  selected: boolean;
  onOpen: (option: CommuteOption) => void;
  /** Said instead of the status under the arrival, when the row is one of the branches. */
  arriveLabel?: string | null;
  /** A line under the ride, for what the times alone do not say. */
  note?: ReactNode;
  className?: string;
}) {
  const status = liveStatus(option, now);
  const leave = leaveLabel(option, now);
  return (
    <button
      type="button"
      onClick={() => onOpen(option)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "grid min-h-14 w-full grid-cols-[84px_1fr_auto] items-center gap-2 rounded-xl px-3 py-2 text-left",
        selected && "bg-[var(--color-surface-2)]",
        status === "missed" && "opacity-55",
        className,
      )}
    >
      <span className="leading-tight">
        <span
          className={cn(
            "block whitespace-nowrap font-bold tabular-nums",
            status === "missed" ? "text-sm" : "text-base",
            leave.big === "Gå nu" && "text-[var(--color-accent)]",
          )}
        >
          {leave.big}
        </span>
        {status === "recommended" ? (
          <span className="block text-[11px] font-semibold text-[var(--color-accent)]">Rekommenderad</span>
        ) : status === "tight" ? (
          <span className="block text-[11px] font-semibold text-[var(--color-warn)]">Knappt</span>
        ) : leave.small ? (
          <span className="block text-[11px] text-[var(--color-muted)]">{leave.small}</span>
        ) : null}
      </span>
      <span className="min-w-0">
        <Ride legs={option.journey.legs} />
        {note ? <span className="mt-0.5 block text-[11px] text-[var(--color-muted)]">{note}</span> : null}
      </span>
      <span className="text-right text-[15px] font-semibold tabular-nums">
        <span className="sr-only">Framme </span>
        {formatTime(option.arriveAt)}
        {arriveLabel ? (
          <span className="block text-[10px] font-semibold text-[var(--color-accent)]">{arriveLabel}</span>
        ) : null}
      </span>
    </button>
  );
}

export function CommuteRows({
  options,
  selectedId,
  now,
  onOpen,
}: {
  options: CommuteOption[];
  selectedId: string | null;
  now: number;
  onOpen: (option: CommuteOption) => void;
}) {
  return (
    <ul aria-label="Resor" className="-mx-3 divide-y divide-[var(--color-border)]">
      {options.map((option) => (
        <li key={option.id}>
          <TripRow option={option} now={now} selected={option.id === selectedId} onOpen={onOpen} className="rounded-none" />
        </li>
      ))}
    </ul>
  );
}
