/**
 * Where the browser's own UI is, so the app's floating chrome can stay clear of it.
 *
 * `position: fixed` is laid out against the tall viewport, the one the page has while
 * the URL bar is scrolled away. Firefox on Android leaves fixed boxes there when the bar
 * slides back in, so the tab bar and the sheet's handle end up behind it; Chrome moves
 * them up with the bar. Rather than encode a guess about either, a hidden probe pinned
 * to `bottom: 0` reports where the bottom of a fixed box actually lands, and the gap
 * from there down to the bottom of what can be seen is published as `--browser-chrome`.
 * Zero on a desktop and in Chrome, the height of the URL bar in Firefox.
 */

/** Above this, the visible area is small because of pinch zoom, not because of the browser. */
const ZOOMED = 1.01;

/** The height of what can actually be seen. */
export function visibleHeight(): number {
  const viewport = window.visualViewport;
  if (!viewport || viewport.scale > ZOOMED) return window.innerHeight;
  return viewport.height;
}

/** Every reason the visible area changes: the phone turning, the keyboard, the URL bar. */
export function onViewportChange(handler: () => void): () => void {
  const viewport = window.visualViewport;
  window.addEventListener("resize", handler);
  viewport?.addEventListener("resize", handler);
  return () => {
    window.removeEventListener("resize", handler);
    viewport?.removeEventListener("resize", handler);
  };
}

/** Installed once for the life of the page; see the note at the top of the file. */
export function trackBrowserChrome(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;

  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;bottom:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none";
  document.body.append(probe);

  let published = -1;
  const measure = () => {
    // Pinch zoom moves the visible area for reasons that have nothing to do with browser
    // UI, and the browser keeps its own chrome in view through a zoom anyway.
    const behind =
      viewport.scale > ZOOMED
        ? 0
        : probe.getBoundingClientRect().bottom - (viewport.offsetTop + viewport.height);
    // A pixel either way is rounding, not a URL bar.
    const gap = behind < 2 ? 0 : Math.round(behind);
    if (gap === published) return;
    published = gap;
    document.documentElement.style.setProperty("--browser-chrome", `${gap}px`);
  };

  measure();
  viewport.addEventListener("resize", measure);
  viewport.addEventListener("scroll", measure);
}
