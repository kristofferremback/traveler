import { Suspense, type ReactNode } from "react";

/** The desktop panel's width and its gap from the rail, which together cover the map's left. */
export const PANEL_WIDTH = 408;
export const PANEL_GAP = 12;

/**
 * The desktop layout for a screen that is a list of things with a place: the map fills
 * the screen and the list floats over its left edge, as tall as what it holds and
 * scrolling inside. The map is given `leftInset={PANEL_GAP + PANEL_WIDTH}` by the caller.
 */
export function MapPanel({
  label,
  map,
  children,
}: {
  label: string;
  map: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="map-panel fixed inset-y-0 right-0 left-[var(--nav-left)]">
      <Suspense fallback={<div className="size-full bg-[var(--color-surface-2)]" />}>{map}</Suspense>
      <section
        aria-label={label}
        className="pointer-events-none absolute top-3 bottom-3 left-3 z-20 flex flex-col"
        style={{ width: PANEL_WIDTH }}
      >
        <div className="pointer-events-auto flex max-h-full flex-col overflow-y-auto rounded-[var(--radius-sheet)] bg-[var(--color-surface)]/92 shadow-[var(--shadow-float)] backdrop-blur-xl">
          {children}
        </div>
      </section>
    </div>
  );
}
