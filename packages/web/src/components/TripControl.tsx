import type { ReactNode } from "react";
import { ArrowLeftRight } from "lucide-react";
import { TimePill, type PlanTime } from "./TimePicker";

/**
 * Where from, where to, and when: one surface over the map.
 *
 * One card rather than three pills, so the question reads as one question. The two
 * ends are buttons that open the picker; the swap sits between them because that is
 * where the journey turns around; the time pill hangs under the card.
 */
export function TripControl({
  fromLabel,
  toLabel,
  time,
  trailing,
  onOpen,
  onSwap,
}: {
  fromLabel: string;
  toLabel: string;
  time: PlanTime;
  /** Controls that belong beside the time pill rather than in the card. */
  trailing?: ReactNode;
  onOpen: (end: "from" | "to" | "time") => void;
  onSwap: () => void;
}) {
  return (
    <div className="pointer-events-auto flex flex-col items-start gap-2">
      <div className="flex w-full items-stretch gap-1 rounded-[var(--radius-card)] bg-[var(--color-surface)]/90 p-1.5 shadow-[var(--shadow-float)] backdrop-blur-xl">
        <End end="from" caption="Från" label={fromLabel} onOpen={onOpen} />
        <button
          type="button"
          onClick={onSwap}
          aria-label="Byt plats på från och till"
          className="grid w-11 shrink-0 place-items-center rounded-xl text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
        >
          <ArrowLeftRight className="size-4" />
        </button>
        <End end="to" caption="Till" label={toLabel} onOpen={onOpen} />
      </div>
      <div className="flex items-center gap-2">
        <TimePill time={time} onOpen={() => onOpen("time")} />
        {trailing}
      </div>
    </div>
  );
}

function End({
  end,
  caption,
  label,
  onOpen,
}: {
  end: "from" | "to";
  caption: string;
  label: string;
  onOpen: (end: "from" | "to") => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(end)}
      aria-haspopup="dialog"
      className="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-xl bg-[var(--color-surface-2)] px-3 py-1 text-left"
    >
      <span className="text-[11px] leading-tight text-[var(--color-muted)]">{caption}</span>
      <span className="truncate text-[15px] font-semibold leading-tight">{label}</span>
    </button>
  );
}
