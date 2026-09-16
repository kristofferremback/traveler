import { Suspense, lazy, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const TransitMap = lazy(() =>
  import("@/components/TransitMap").then((m) => ({ default: m.TransitMap })),
);

/** The desktop panel's width and its gap from the rail, which together cover the map's left. */
export const PANEL_WIDTH = 408;
export const PANEL_GAP = 12;

/**
 * A card floating over the map on a desktop, as tall as what it holds up to the screen's
 * height. The section spans the full height and lets the map take the pointer below the card.
 */
export function FloatingCard({
  label,
  style,
  className,
  children,
}: {
  label?: string;
  style: CSSProperties;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="pointer-events-none absolute top-3 bottom-3 z-20 flex flex-col"
      style={style}
    >
      <div
        className={cn(
          "pointer-events-auto flex max-h-full flex-col rounded-[var(--radius-sheet)] bg-[var(--color-surface)]/92 shadow-[var(--shadow-float)] backdrop-blur-xl",
          className,
        )}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * The desktop layout for a screen that is a list of things with a place: the map fills
 * the screen and the list floats over its left edge, scrolling inside.
 */
export function MapPanel({
  label,
  map,
  children,
}: {
  label: string;
  map: ComponentProps<typeof TransitMap>;
  children: ReactNode;
}) {
  return (
    <div className="map-panel fixed inset-y-0 right-0 left-[var(--nav-left)]">
      <Suspense fallback={<div className="size-full bg-[var(--color-surface-2)]" />}>
        <TransitMap {...map} leftInset={PANEL_GAP + PANEL_WIDTH} className="relative size-full" />
      </Suspense>
      <FloatingCard label={label} style={{ left: PANEL_GAP, width: PANEL_WIDTH }} className="overflow-y-auto">
        {children}
      </FloatingCard>
    </div>
  );
}
