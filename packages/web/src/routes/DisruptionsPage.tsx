import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Deviation, DeviationsResponse } from "@traveler/shared";
import { streams } from "@/lib/api";
import { useStream } from "@/hooks/useStream";
import { useDesktop, useDesktopKeys } from "@/hooks/useDesktop";
import {
  DeviationDetail,
  DeviationHeadlines,
  DeviationList,
  NoDeviations,
} from "@/components/DeviationList";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const LEVELS = [
  { value: "major", label: "Störningar" },
  { value: "info", label: "Allt" },
] as const;

export function DisruptionsPage() {
  const desktop = useDesktop();
  const [params, setParams] = useSearchParams();
  const [minSeverity, setMinSeverity] = useState<"major" | "info">("major");
  const { data, connected } = useStream<DeviationsResponse>(
    streams.deviations({ minSeverity }),
    "deviations",
  );
  const deviations = data?.deviations ?? [];

  // The notice read in full beside the list on a desktop. Without one in the URL it is the
  // first, so the pane is never empty. One in the URL that the stream has since dropped
  // stays selected and says it is gone, rather than quietly showing a different notice.
  const picked = params.get("d");
  const selected: Deviation | null = picked
    ? (deviations.find((d) => String(d.id) === picked) ?? null)
    : (deviations[0] ?? null);

  /** Replaces the entry: stepping through notices is reading one page, not thirty. */
  function pick(id: number | null) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id === null) next.delete("d");
        else next.set("d", String(id));
        return next;
      },
      { replace: true },
    );
  }

  // Focus follows the keys, so Tab and a screen reader carry on from the notice being read.
  // After the render that moved the selection, which the router may defer past a frame.
  const focusSelected = useRef(false);
  useDesktopKeys((e, target) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    // Not while reading: in the notice itself the keys scroll it.
    if (e.shiftKey || target?.closest("[data-notice]") || deviations.length === 0) return;
    e.preventDefault();
    const at = selected ? deviations.indexOf(selected) : -1;
    const next =
      e.key === "ArrowDown" ? Math.min(at + 1, deviations.length - 1) : Math.max(at - 1, 0);
    if (next === at) return;
    focusSelected.current = true;
    pick(deviations[next]!.id);
  });
  useEffect(() => {
    if (!focusSelected.current) return;
    focusSelected.current = false;
    document
      .querySelector<HTMLElement>('[aria-label="Meddelanden"] [aria-current="true"]')
      ?.focus();
  }, [selected?.id]);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-24 lg:max-w-6xl lg:pb-8">
      <header className="flex items-center justify-between gap-2 pb-3 pt-3 safe-top">
        <h1 className="text-lg font-semibold">Trafikläget</h1>
        <div role="tablist" aria-label="Nivå" className="flex gap-1.5">
          {LEVELS.map((level) => (
            <button
              key={level.value}
              role="tab"
              aria-selected={minSeverity === level.value}
              onClick={() => {
                setMinSeverity(level.value);
                // What was selected may not be at the other level, and that is not "gone".
                if (picked) pick(null);
              }}
              className={cn(
                "min-h-11 min-w-20 rounded-full border px-4 text-xs",
                minSeverity === level.value
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-bg)]"
                  : "border-[var(--color-border)] text-[var(--color-muted)]",
              )}
            >
              {level.label}
            </button>
          ))}
        </div>
      </header>

      {!connected && !data ? (
        <ul className="space-y-2" aria-busy="true" aria-label="Hämtar störningar">
          {[0, 1, 2].map((i) => (
            <li key={i}>
              <Skeleton className="h-24 w-full" />
            </li>
          ))}
        </ul>
      ) : !desktop ? (
        <DeviationList deviations={deviations} />
      ) : deviations.length === 0 && !picked ? (
        <NoDeviations />
      ) : (
        <div className="grid grid-cols-[380px_minmax(0,1fr)] items-start gap-6">
          <DeviationHeadlines
            deviations={deviations}
            selectedId={selected?.id ?? null}
            onSelect={(deviation) => pick(deviation.id)}
          />
          {/* Focusable, so a notice longer than the screen can be scrolled with the keys. */}
          <section
            aria-label="Meddelandet"
            data-notice
            tabIndex={0}
            className="sticky top-3 max-h-[calc(100dvh-1.5rem)] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
          >
            <DeviationDetail deviation={selected} />
          </section>
        </div>
      )}
    </div>
  );
}
