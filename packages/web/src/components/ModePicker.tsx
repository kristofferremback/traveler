import { useEffect, useRef, useState } from "react";
import type { TransportMode } from "@traveler/shared";
import { Filter, X } from "lucide-react";
import { MODE_FILTERS, MODE_ICON, describeModes, selectedFilters, toggleMode } from "@/lib/modes";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

/**
 * The mode filter as one pill beside the time pill.
 *
 * Same shape and same place as the time, because it is the same kind of thing: a
 * condition on the question rather than an answer to it. Nothing chosen means the whole
 * network, and then the pill says what it is instead of what it holds, since a pill
 * reading "alla färdmedel" next to "Nu" is two words for "I have not decided anything".
 */
export function ModePill({ modes, onOpen }: { modes: TransportMode[]; onOpen: () => void }) {
  const chosen = selectedFilters(modes);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      className={cn(
        "pointer-events-auto inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full bg-[var(--color-surface)]/90 px-3.5 text-sm font-medium shadow-[var(--shadow-float)] backdrop-blur-xl",
        chosen.length > 0 && "text-[var(--color-accent)]",
      )}
    >
      <Filter className="size-4 shrink-0 text-[var(--color-muted)]" aria-hidden />
      <span className="truncate">{describeModes(modes)}</span>
    </button>
  );
}

/**
 * Choosing which modes the trip may use.
 *
 * The choice is held here and committed on "Klar", like the time picker: each toggle
 * would otherwise be a URL change and a round of trip requests, and picking two modes
 * would ask SL about the first one on the way past. "Alla" is the way back, and turning
 * the last box off gets there too.
 */
export function ModePicker({
  modes,
  onPick,
  onClose,
}: {
  modes: TransportMode[];
  onPick: (modes: TransportMode[]) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [chosen, setChosen] = useState<TransportMode[]>(modes);

  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
  }, []);

  const picked = selectedFilters(chosen);

  return (
    <dialog
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label="Välj färdmedel"
      className="m-0 mt-auto w-full max-w-none rounded-t-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg)] backdrop:bg-black/50 sm:mx-auto sm:mb-auto sm:mt-[10dvh] sm:max-w-md sm:rounded-[var(--radius-card)]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <h2 className="text-sm font-semibold">Vilka färdmedel?</h2>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Stäng">
          <X />
        </Button>
      </div>

      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          onPick(chosen);
        }}
      >
        <ul className="space-y-1">
          {MODE_FILTERS.map((filter) => {
            const Icon = MODE_ICON[filter.modes[0]!];
            const on = picked.includes(filter);
            return (
              <li key={filter.label}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-2 text-[15px] hover:bg-[var(--color-surface-2)]">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => setChosen((prev) => toggleMode(prev, filter))}
                    className="size-5 accent-[var(--color-accent)]"
                  />
                  <Icon className="size-4 text-[var(--color-muted)]" aria-hidden />
                  <span>{filter.label}</span>
                </label>
              </li>
            );
          })}
        </ul>

        <p className="text-xs text-[var(--color-muted)]">
          {picked.length === 0
            ? "Inget valt betyder hela nätet."
            : "Bara resor som går hela vägen med det du valt visas."}
        </p>

        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" onClick={() => setChosen([])} disabled={picked.length === 0}>
            Alla
          </Button>
          <Button type="submit">Klar</Button>
        </div>
      </form>
    </dialog>
  );
}
