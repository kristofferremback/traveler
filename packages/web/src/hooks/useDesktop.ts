import { useCallback, useSyncExternalStore } from "react";
import { DESKTOP_QUERY, WIDE_QUERY } from "@/lib/viewport";

/**
 * Whether the desktop layout is on screen, for the few places where it is a different
 * structure rather than different classes: a panel instead of a sheet, a popover instead
 * of a full screen, a camera fitted beside the list instead of above it.
 *
 * Styling alone uses Tailwind's `lg:`, which is the same breakpoint.
 */
export function useDesktop(): boolean {
  return useMedia(DESKTOP_QUERY);
}

/** Whether an opened trip gets a column beside the list; see WIDE_QUERY. */
export function useWide(): boolean {
  return useMedia(WIDE_QUERY);
}

function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}
