import { useSyncExternalStore } from "react";
import { DESKTOP_QUERY } from "@/lib/viewport";

/**
 * Whether the desktop layout is on screen, for the few places where it is a different
 * structure rather than different classes: a panel instead of a sheet, a popover instead
 * of a full screen, a camera fitted beside the list instead of above it.
 *
 * Styling alone uses Tailwind's `lg:`, which is the same breakpoint.
 */
export function useDesktop(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(DESKTOP_QUERY).matches);
}

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
