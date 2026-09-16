import { useLayoutEffect, useState, type CSSProperties, type MouseEvent } from "react";
import { onViewportChange } from "@/lib/viewport";
import { useDesktop } from "./useDesktop";

/** Space between the control and the popover under it, and kept from the window's edges. */
const GAP = 8;
const EDGE = 12;

/**
 * Where a picker goes on a desktop: under the control that opened it, rather than in the
 * middle of the screen with the map dimmed behind it.
 *
 * The control is found by its `data-popover-anchor`, not handed over as an element: the
 * pickers are opened from history state, so a Back and Forward can open one without the
 * click that would have supplied it. On a phone, or when nothing carries the name, the
 * picker keeps its own layout.
 *
 * Still a modal `<dialog>` either way, so focus, Escape and Back behave the same. A click
 * outside it closes it, the way a popover does.
 */
export function usePopover(
  anchor: string,
  minWidth: number,
  onClose: () => void,
): {
  anchored: boolean;
  /** A popover floats over the map with it still showing, instead of dimming it. */
  className: string | undefined;
  style: CSSProperties | undefined;
  onClick: (e: MouseEvent<HTMLDialogElement>) => void;
} {
  const desktop = useDesktop();
  const [rect, setRect] = useState<DOMRect | null>(null);

  // Before paint, so the dialog never shows in the middle first.
  useLayoutEffect(() => {
    if (!desktop) {
      setRect(null);
      return;
    }
    const measure = () =>
      setRect(document.querySelector(`[data-popover-anchor="${anchor}"]`)?.getBoundingClientRect() ?? null);
    measure();
    return onViewportChange(measure);
  }, [desktop, anchor]);

  if (!rect) return { anchored: false, className: undefined, style: undefined, onClick: () => {} };

  const width = Math.max(minWidth, rect.width);
  const top = rect.bottom + GAP;
  return {
    anchored: true,
    className: "shadow-[var(--shadow-float)] backdrop:bg-transparent",
    style: {
      position: "fixed",
      inset: "auto",
      margin: 0,
      top,
      left: Math.max(EDGE, Math.min(rect.left, window.innerWidth - width - EDGE)),
      width,
      maxHeight: window.innerHeight - top - EDGE,
    },
    // A click on the backdrop lands on the dialog element itself, outside its box. Enter or
    // Space on a control inside also clicks, at 0,0, so the target has to be the dialog too.
    onClick: (e) => {
      if (e.target !== e.currentTarget) return;
      const box = e.currentTarget.getBoundingClientRect();
      const outside =
        e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom;
      if (outside) onClose();
    },
  };
}
