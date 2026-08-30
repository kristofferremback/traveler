import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { onViewportChange, visibleHeight } from "@/lib/viewport";
import { cn } from "@/lib/utils";

/**
 * The hero peeks over the fold, which is the point of the screen: when to leave, on
 * what, and when you land, without touching anything.
 */
export const PEEK_HEIGHT = 236;
/**
 * Only the handle: the map is as full-screen as it gets while the app keeps its bar.
 * A thumb's worth, because tucked the handle is the only way back to the list.
 */
const TUCKED_HEIGHT = 44;
/**
 * The tab bar under the sheet: 3.5rem of links plus its safe-area padding, which is at
 * least 0.75rem. The sheet's heights are measured from the top of the bar, so the bar
 * has to come off the viewport before the gap does.
 */
const TAB_BAR = 56 + 12;

export type Snap = "tucked" | "peek" | "half" | "full";

function snapHeights(viewport: number, topGap: number): Record<Snap, number> {
  const usable = viewport - TAB_BAR;
  return {
    tucked: TUCKED_HEIGHT,
    peek: PEEK_HEIGHT,
    half: Math.round(usable * 0.5),
    full: Math.max(Math.round(usable * 0.5), usable - topGap),
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
  topGap,
  onHeightChange,
  onSettle,
}: {
  children: ReactNode;
  /** Names the region for a screen reader; the visible header is inside `children`. */
  label: string;
  /**
   * Map left uncovered at full height, so whatever floats up there stays reachable. The
   * caller measures it rather than naming a number, because what floats over the map is
   * a stack of controls whose height depends on how long the labels in it are.
   */
  topGap: number;
  /**
   * Every height the sheet passes through, including each pixel of a drag. For anything
   * that has to track the sheet continuously, and cheap enough to do so.
   */
  onHeightChange?: (height: number) => void;
  /**
   * Where the sheet came to rest: a snap, a resize, the end of a drag. What a caller
   * holding the height in state should listen to, so a drag is not a hundred renders of
   * whatever is on the screen behind it.
   */
  onSettle?: (height: number) => void;
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

  /**
   * The four heights as they stand right now.
   *
   * Measured on every use rather than held: the visible height changes when the phone
   * turns, when the keyboard opens, and on Android every time the URL bar slides in or
   * out, and a sheet sized for the old one either floats or runs off the screen.
   */
  const heights = () => snapHeights(visibleHeight(), topGap);

  /** A height that is not on its way anywhere: reported to both callbacks. */
  const rest = useCallback(
    (next: number) => {
      report(next);
      onSettle?.(next);
    },
    [report, onSettle],
  );

  useEffect(() => {
    const resize = () => rest(heights()[snap]);
    resize();
    return onViewportChange(resize);
  }, [snap, rest, topGap]);

  const settle = (target: number) => {
    const snaps = heights();
    const nearest = (Object.keys(snaps) as Snap[]).reduce((best, key) =>
      Math.abs(snaps[key] - target) < Math.abs(snaps[best] - target) ? key : best,
    );
    setSnap(nearest);
    rest(snaps[nearest]);
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
    const snaps = heights();
    report(Math.min(snaps.full, Math.max(snaps.tucked, state.startHeight + delta)));
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
    rest(heights()[next]);
  };

  // Escape gets out of a covered map without hunting for the handle.
  useEffect(() => {
    if (snap === "peek") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSnap("peek");
      rest(heights().peek);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snap, rest]);

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <section
      aria-label={label}
      style={{ height }}
      className={cn(
        "pointer-events-auto fixed inset-x-0 bottom-[calc(3.5rem+max(0.75rem,env(safe-area-inset-bottom,0px))+var(--browser-chrome))] z-20 flex flex-col rounded-t-[var(--radius-sheet)] bg-[var(--color-surface)]/92 shadow-[var(--shadow-sheet)] backdrop-blur-xl",
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
        className="flex h-11 w-full shrink-0 touch-none items-center justify-center"
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
