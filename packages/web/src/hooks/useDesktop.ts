import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

/**
 * The desktop layout's breakpoint: Tailwind's `lg`, 1024 px, where the tab bar becomes a
 * rail. Kept in step with `--nav-left` and `--nav-bottom` in index.css.
 */
const DESKTOP_QUERY = "(width >= 64rem)";

/**
 * Wide enough for an opened trip to sit in a column of its own beside the list, rather
 * than in place of it: rail, panel, column and still 500 px of map.
 */
const WIDE_QUERY = "(width >= 80rem)";

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

/**
 * A page's keyboard shortcuts, on a desktop only.
 *
 * Never while typing, never with a modifier (the browser's own shortcuts stay the
 * browser's), and never under an open picker, which has keys of its own.
 */
export function useDesktopKeys(onKey: (event: KeyboardEvent, target: Element | null) => void) {
  const desktop = useDesktop();
  const latest = useRef(onKey);
  latest.current = onKey;
  useEffect(() => {
    if (!desktop) return;
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector("dialog[open]")) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      latest.current(event, target);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [desktop]);
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
