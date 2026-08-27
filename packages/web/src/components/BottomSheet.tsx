import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The hero peeks over the fold, which is the point of the screen: when to leave, on
 * what, and when you land, without touching anything.
 */
export const PEEK_HEIGHT = 236;
/** Only the handle: the map is as full-screen as it gets while the app keeps its bar. */
const TUCKED_HEIGHT = 30;
/** Chips and the map's controls stay reachable at full height: this much map stays uncovered. */
const TOP_GAP = 132;
/**
 * The tab bar under the sheet: 3.5rem of links plus its safe-area padding, which is at
 * least 0.75rem. The sheet's heights are measured from the top of the bar, so the bar
 * has to come off the viewport before the gap does.
 */
const TAB_BAR = 56 + 12;

export type Snap = "tucked" | "peek" | "half" | "full";

function snapHeights(viewport: number): Record<Snap, number> {
  const usable = viewport - TAB_BAR;
  return {
    tucked: TUCKED_HEIGHT,
    peek: PEEK_HEIGHT,
    half: Math.round(usable * 0.5),
    full: Math.max(Math.round(usable * 0.5), usable - TOP_GAP),
  };
}

/**
 * The sheet over the map.
 *
 * Written here rather than pulled in: a sheet is a handle, three heights and a drag, and
 * the libraries that do it bring a focus-trapping modal with them -- which is the wrong
 * behaviour for a panel the traveller is meant to read *while* looking at the map behind
 * it.
 *
 * The handle is a real button, so the keyboard cycles the heights and a screen reader is
 * told what it does. Dragging is pointer events, so a mouse works the same as a thumb.
 */
export function BottomSheet({
  children,
  label,
  onHeightChange,
}: {
  children: ReactNode;
  /** Names the region for a screen reader; the visible header is inside `children`. */
  label: string;
  onHeightChange?: (height: number) => void;
}) {
  const [snap, setSnap] = useState<Snap>("peek");
  const [height, setHeight] = useState(PEEK_HEIGHT);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startY: number; startHeight: number; moved: boolean } | null>(null);
  /** A drag ends with a click event too; this stops that click from also cycling. */
  const draggedRef = useRef(false);

  const report = useCallback(
    (next: number) => {
      setHeight(next);
      onHeightChange?.(next);
    },
    [onHeightChange],
  );

  // The viewport changes when the on-screen keyboard opens or the phone turns, and a
  // sheet still sized for the old one either floats or covers the map.
  useEffect(() => {
    const resize = () => report(snapHeights(window.innerHeight)[snap]);
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [snap, report]);

  const settle = (target: number) => {
    const heights = snapHeights(window.innerHeight);
    const nearest = (Object.keys(heights) as Snap[]).reduce((best, key) =>
      Math.abs(heights[key] - target) < Math.abs(heights[best] - target) ? key : best,
    );
    setSnap(nearest);
    report(heights[nearest]);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startHeight: height, moved: false };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state) return;
    const delta = state.startY - e.clientY;
    if (Math.abs(delta) > 6) state.moved = true;
    const heights = snapHeights(window.innerHeight);
    report(Math.min(heights.full, Math.max(heights.tucked, state.startHeight + delta)));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    drag.current = null;
    setDragging(false);
    if (!state) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    // A tap that never moved is a tap: the click handler cycles the heights.
    if (state.moved) {
      draggedRef.current = true;
      settle(height);
    }
  };

  const cycle = () => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    // A tap from tucked brings the sheet back; otherwise it climbs and wraps. Tucking
    // is a drag, never a tap, so a tap can never make the list vanish by surprise.
    const order: Snap[] = ["peek", "half", "full"];
    const next = snap === "tucked" ? "peek" : order[(order.indexOf(snap) + 1) % order.length]!;
    setSnap(next);
    report(snapHeights(window.innerHeight)[next]);
  };

  // Escape gets out of a covered map without hunting for the handle.
  useEffect(() => {
    if (snap === "peek") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSnap("peek");
      report(snapHeights(window.innerHeight).peek);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snap, report]);

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <section
      aria-label={label}
      style={{ height }}
      className={cn(
        "pointer-events-auto fixed inset-x-0 bottom-[calc(3.5rem+max(0.75rem,env(safe-area-inset-bottom,0px)))] z-20 flex flex-col rounded-t-[var(--radius-sheet)] bg-[var(--color-surface)]/92 shadow-[var(--shadow-sheet)] backdrop-blur-xl",
        !dragging && !reduceMotion && "transition-[height] duration-200",
      )}
    >
      <button
        type="button"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={cycle}
        aria-label={
          snap === "tucked" ? "Visa resor" : snap === "full" ? "Fäll ihop listan" : "Visa fler resor"
        }
        className="flex h-[30px] w-full shrink-0 touch-none items-center justify-center"
      >
        <span
          className="block h-1.5 w-10 rounded-full bg-[var(--color-muted)]/45"
          aria-hidden
        />
      </button>
      <div className={cn("min-h-0 flex-1", snap === "half" || snap === "full" ? "overflow-y-auto" : "overflow-hidden")}>
        {children}
      </div>
    </section>
  );
}
