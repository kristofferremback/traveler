import type { Deviation } from "@traveler/shared";
import { Info, TriangleAlert, OctagonAlert } from "lucide-react";
import { LineBadge } from "./LineBadge";
import { Card } from "./ui/card";

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

export function DeviationList({ deviations }: { deviations: Deviation[] }) {
  if (deviations.length === 0) {
    return (
      <p className="rounded-lg border border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted)]">
        Inga störningar just nu.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {deviations.map((deviation) => {
        const Icon = ICON[deviation.severity];
        // SL repeats the same line at several stop areas, so the badges are deduped.
        const lines = [
          ...new Map(deviation.lines.map((l) => [`${l.mode}${l.designation}`, l])).values(),
        ];
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
                  {lines.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {lines.slice(0, 12).map((line) => (
                        <LineBadge key={`${line.mode}${line.designation}`} line={line} />
                      ))}
                      {lines.length > 12 ? (
                        <span className="text-xs text-[var(--color-muted)]">
                          +{lines.length - 12}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
