import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * An overlay that lives in the history rather than in a boolean.
 *
 * Opening it pushes an entry, so the phone's Back gesture closes it; an overlay Back
 * does not close is a trap on a phone, where Back is a swipe people make without
 * looking. Which overlay is open rides in the history state rather than in the URL, so
 * a link copied from the screen is the trip and not the picker that happened to be open.
 *
 * Choosing something calls `settle`, which turns that entry into the result, so the
 * picker never survives in the history it opened from.
 */
export function useOverlay<T extends string>(): {
  open: T | null;
  show: (which: T) => void;
  close: () => void;
  settle: (search: URLSearchParams) => void;
} {
  const location = useLocation();
  const navigate = useNavigate();
  const { pathname, search } = location;

  const show = useCallback(
    (which: T) => navigate({ pathname, search }, { state: { overlay: which } }),
    [navigate, pathname, search],
  );
  const close = useCallback(() => navigate(-1), [navigate]);

  /**
   * Close on an answer: the overlay's own entry becomes the result.
   *
   * Not a close followed by a change. Going back first would land on the entry before
   * the overlay and apply the answer there, so Back from the result would step through
   * a search nobody asked for.
   */
  const settle = useCallback(
    (next: URLSearchParams) =>
      navigate({ pathname, search: `?${next.toString()}` }, { replace: true, state: null }),
    [navigate, pathname],
  );

  return {
    open: (location.state as { overlay?: T } | null)?.overlay ?? null,
    show,
    close,
    settle,
  };
}
