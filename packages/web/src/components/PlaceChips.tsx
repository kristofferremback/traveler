import { ArrowLeftRight } from "lucide-react";
import { Button } from "./ui/button";

/**
 * Where from and where to, as two pills over the map.
 *
 * They read as the current trip and act as the way to change it: the label is the
 * answer, tapping it asks the question again. The swap sits between them because that is
 * where the journey turns around.
 */
export function PlaceChips({
  fromLabel,
  toLabel,
  onOpen,
  onSwap,
}: {
  fromLabel: string;
  toLabel: string;
  onOpen: (end: "from" | "to") => void;
  onSwap: () => void;
}) {
  return (
    <div className="pointer-events-auto flex items-center gap-1.5">
      <Chip end="from" caption="Från" label={fromLabel} onOpen={onOpen} />
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={onSwap}
        aria-label="Byt plats på från och till"
        className="shrink-0 bg-[var(--color-surface)]/95 backdrop-blur"
      >
        <ArrowLeftRight />
      </Button>
      <Chip end="to" caption="Till" label={toLabel} onOpen={onOpen} />
    </div>
  );
}

function Chip({
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
      className="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]/95 px-3 py-1 text-left backdrop-blur"
    >
      <span className="text-[11px] leading-tight text-[var(--color-muted)]">{caption}</span>
      <span className="truncate text-sm font-medium leading-tight">{label}</span>
    </button>
  );
}
