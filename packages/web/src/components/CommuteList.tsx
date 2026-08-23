import { useState } from "react";
import type { CommuteOption } from "@traveler/shared";
import { ChevronDown } from "lucide-react";
import { CommuteRow } from "./CommuteRow";
import { cn } from "@/lib/utils";

/**
 * The ranked options, best first.
 *
 * What was missed is kept, folded away at the end: it answers "did I just miss it?",
 * which is a real question at a bus stop, without letting a departure that has gone
 * push the next one off the screen.
 */
export function CommuteList({
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
  const [showMissed, setShowMissed] = useState(false);
  const live = options.filter((o) => o.status !== "missed");
  const missed = options.filter((o) => o.status === "missed");

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {live.map((option) => (
          <CommuteRow
            key={option.id}
            option={option}
            selected={option.id === selectedId}
            now={now}
            onSelect={() => onSelect(option)}
          />
        ))}
      </ul>

      {missed.length > 0 ? (
        <div>
          <button
            type="button"
            onClick={() => setShowMissed((v) => !v)}
            aria-expanded={showMissed}
            className="flex min-h-11 w-full items-center justify-between gap-2 text-sm text-[var(--color-muted)]"
          >
            <span>Missade ({missed.length})</span>
            <ChevronDown
              className={cn("size-4 transition-transform", showMissed && "rotate-180")}
              aria-hidden
            />
          </button>
          {showMissed ? (
            <ul className="space-y-2">
              {missed.map((option) => (
                <CommuteRow
                  key={option.id}
                  option={option}
                  selected={option.id === selectedId}
                  now={now}
                  onSelect={() => onSelect(option)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
