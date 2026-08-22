import { useState } from "react";
import type { DeviationsResponse } from "@traveler/shared";
import { streams } from "@/lib/api";
import { useStream } from "@/hooks/useStream";
import { DeviationList } from "@/components/DeviationList";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const LEVELS = [
  { value: "major", label: "Störningar" },
  { value: "info", label: "Allt" },
] as const;

export function DisruptionsPage() {
  const [minSeverity, setMinSeverity] = useState<"major" | "info">("major");
  const { data, connected } = useStream<DeviationsResponse>(
    streams.deviations({ minSeverity }),
    "deviations",
  );

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-24">
      <header className="flex items-center justify-between gap-2 pb-3 pt-3 safe-top">
        <h1 className="text-lg font-semibold">Trafikläget</h1>
        <div role="tablist" aria-label="Nivå" className="flex gap-1.5">
          {LEVELS.map((level) => (
            <button
              key={level.value}
              role="tab"
              aria-selected={minSeverity === level.value}
              onClick={() => setMinSeverity(level.value)}
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
      ) : (
        <DeviationList deviations={data?.deviations ?? []} />
      )}
    </div>
  );
}
