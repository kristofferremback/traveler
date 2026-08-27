import type { CommuteOption } from "@traveler/shared";
import { formatTime } from "@/lib/format";
import { LineBadge } from "./LineBadge";
import { leaveLabel } from "./CommuteHero";
import { cn } from "@/lib/utils";

/**
 * Every option as a small card in one row, best first, missed last and dimmed.
 *
 * A card is the least that still lets the traveller choose: when to leave, when you
 * land, on what. Tapping one makes it the hero above; the row scrolls sideways so the
 * list never pushes the hero off the screen.
 */
export function CommuteCards({
  options,
  selectedId,
  now,
  onSelect,
}: {
  options: CommuteOption[];
  selectedId: string | null;
  now: number;
  onSelect: (option: CommuteOption) => void;
}) {
  return (
    <ul
      aria-label="Resor"
      className="-mx-3 flex snap-x gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none]"
    >
      {options.map((option) => {
        const rides = option.journey.legs.filter((leg) => leg.mode !== "WALK");
        const selected = option.id === selectedId;
        const leave = leaveLabel(option, now);
        return (
          <li key={option.id} className="shrink-0 snap-start">
            <button
              type="button"
              onClick={() => onSelect(option)}
              aria-pressed={selected}
              className={cn(
                "flex min-h-11 w-[132px] flex-col rounded-2xl px-3 py-2.5 text-left",
                selected
                  ? "bg-[var(--color-fg)] text-[var(--color-bg)]"
                  : "bg-[var(--color-surface-2)] text-[var(--color-fg)]",
                option.status === "missed" && !selected && "opacity-55",
              )}
            >
              <span className="text-[17px] font-bold leading-tight tabular-nums">{leave.big}</span>
              <span className={cn("text-xs tabular-nums", selected ? "opacity-75" : "text-[var(--color-muted)]")}>
                Framme {formatTime(option.arriveAt)}
              </span>
              <span className="mt-1.5 flex flex-wrap items-center gap-1">
                {rides.map((leg) => (
                  <LineBadge key={leg.index} line={leg.line} mode={leg.mode} className="min-h-5 text-[11px]" />
                ))}
                {option.transfers > 0 ? (
                  <span className={cn("text-[11px]", selected ? "opacity-75" : "text-[var(--color-muted)]")}>
                    {option.transfers} byte{option.transfers > 1 ? "n" : ""}
                  </span>
                ) : null}
              </span>
              {option.status === "recommended" ? (
                <span className={cn("mt-1 text-[11px] font-semibold", selected ? "opacity-90" : "text-[var(--color-accent)]")}>
                  Rekommenderad
                </span>
              ) : option.status === "tight" ? (
                <span className="mt-1 text-[11px] font-semibold text-[var(--color-warn)]">Knappt</span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
