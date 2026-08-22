import type { LineRef, TransportMode } from "@traveler/shared";
import { MODE_ICON, MODE_LABEL, modeColor } from "@/lib/modes";
import { cn } from "@/lib/utils";

/**
 * A line, coloured the way SL colours it. The mode name is in the accessible label
 * because the colour alone carries meaning that a screen reader cannot see and a
 * colour-blind traveller may not distinguish.
 */
export function LineBadge({
  line,
  mode,
  className,
}: {
  line?: LineRef | null;
  mode?: TransportMode;
  className?: string;
}) {
  const resolved = line?.mode ?? mode ?? "UNKNOWN";
  const Icon = MODE_ICON[resolved];
  const color = modeColor(resolved, line?.designation);
  const designation = line?.designation?.trim();

  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center gap-1 rounded-md px-1.5 text-xs font-bold text-white",
        className,
      )}
      style={{ backgroundColor: color }}
    >
      <Icon className="size-3.5" aria-hidden />
      {designation ? <span>{designation}</span> : null}
      <span className="sr-only">
        {MODE_LABEL[resolved]}
        {designation ? ` linje ${designation}` : ""}
      </span>
    </span>
  );
}

export function ModeChips({ modes }: { modes: TransportMode[] }) {
  if (modes.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {modes.map((mode) => {
        const Icon = MODE_ICON[mode];
        return (
          <span key={mode} title={MODE_LABEL[mode]}>
            <Icon className="size-3.5" style={{ color: modeColor(mode) }} aria-hidden />
            <span className="sr-only">{MODE_LABEL[mode]}</span>
          </span>
        );
      })}
    </span>
  );
}
