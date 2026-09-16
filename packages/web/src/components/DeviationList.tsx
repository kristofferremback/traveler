import type { Deviation } from "@traveler/shared";
import { Info, TriangleAlert, OctagonAlert } from "lucide-react";
import { LineBadge } from "./LineBadge";
import { Card } from "./ui/card";
import { cn } from "@/lib/utils";

const ICON = {
  info: Info,
  minor: Info,
  major: TriangleAlert,
  severe: OctagonAlert,
} as const;

const TONE = {
  info: "text-[var(--color-muted)]",
  minor: "text-[var(--color-muted)]",
  major: "text-[var(--color-warn)]",
  severe: "text-[var(--color-danger)]",
} as const;

const SEVERITY_LABEL = {
  info: "Information",
  minor: "Mindre störning",
  major: "Störning",
  severe: "Allvarlig störning",
} as const;

/** SL repeats the same line at several stop areas, so the badges are deduped. */
function linesOf(deviation: Deviation) {
  return [...new Map(deviation.lines.map((l) => [`${l.mode}${l.designation}`, l])).values()];
}

function LineBadges({ deviation, max }: { deviation: Deviation; max: number }) {
  const lines = linesOf(deviation);
  if (lines.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {lines.slice(0, max).map((line) => (
        <LineBadge key={`${line.mode}${line.designation}`} line={line} />
      ))}
      {lines.length > max ? (
        <span className="text-xs text-[var(--color-muted)]">+{lines.length - max}</span>
      ) : null}
    </div>
  );
}

export function NoDeviations() {
  return (
    <p className="rounded-lg border border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted)]">
      Inga störningar just nu.
    </p>
  );
}

export function DeviationList({ deviations }: { deviations: Deviation[] }) {
  if (deviations.length === 0) return <NoDeviations />;

  return (
    <ul className="space-y-2">
      {deviations.map((deviation) => {
        const Icon = ICON[deviation.severity];
        return (
          <li key={deviation.id}>
            <Card className="p-4">
              <div className="flex gap-3">
                <Icon className={`mt-0.5 size-4 shrink-0 ${TONE[deviation.severity]}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold">
                    <span className="sr-only">{SEVERITY_LABEL[deviation.severity]}: </span>
                    {deviation.header}
                  </h3>
                  {deviation.details && deviation.details !== deviation.header ? (
                    <p className="mt-1 whitespace-pre-line text-xs text-[var(--color-muted)]">
                      {deviation.details}
                    </p>
                  ) : null}
                  <LineBadges deviation={deviation} max={12} />
                </div>
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The headlines alone, for a desktop, where the one you pick is read in full beside the
 * list. Thirty notices fit on one screen this way; as cards, the long ones fill it alone.
 */
export function DeviationHeadlines({
  deviations,
  selectedId,
  onSelect,
}: {
  deviations: Deviation[];
  selectedId: number | null;
  onSelect: (deviation: Deviation) => void;
}) {
  return (
    <ul aria-label="Meddelanden" className="divide-y divide-[var(--color-border)]">
      {deviations.map((deviation) => {
        const Icon = ICON[deviation.severity];
        return (
          <li key={deviation.id}>
            <button
              type="button"
              aria-current={deviation.id === selectedId ? "true" : undefined}
              onClick={() => onSelect(deviation)}
              className={cn(
                "flex min-h-14 w-full gap-3 rounded-xl px-3 py-3 text-left",
                deviation.id === selectedId
                  ? "bg-[var(--color-surface-2)]"
                  : "hover:bg-[var(--color-surface-2)]/60",
              )}
            >
              <Icon className={`mt-0.5 size-4 shrink-0 ${TONE[deviation.severity]}`} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  <span className="sr-only">{SEVERITY_LABEL[deviation.severity]}: </span>
                  {deviation.header}
                </span>
                <LineBadges deviation={deviation} max={6} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** One notice in full. Null is a notice that was selected and has since been lifted. */
export function DeviationDetail({ deviation }: { deviation: Deviation | null }) {
  if (!deviation) {
    return (
      <p className="text-sm text-[var(--color-muted)]">
        Meddelandet gäller inte längre. Välj ett annat i listan.
      </p>
    );
  }
  const Icon = ICON[deviation.severity];
  return (
    <article>
      <p className={`flex items-center gap-2 text-xs font-medium ${TONE[deviation.severity]}`}>
        <Icon className="size-4" aria-hidden />
        {SEVERITY_LABEL[deviation.severity]}
      </p>
      <h2 className="mt-2 text-xl font-semibold">{deviation.header}</h2>
      {deviation.details && deviation.details !== deviation.header ? (
        <p className="mt-3 max-w-prose whitespace-pre-line text-sm leading-relaxed">
          {deviation.details}
        </p>
      ) : null}
      <LineBadges deviation={deviation} max={Infinity} />
    </article>
  );
}
