import { useEffect, useRef, useState } from "react";

/**
 * Whether the server is serving a newer build than the one this tab is running.
 *
 * A deploy replaces the fingerprinted entry bundle and `index.html` is served
 * `no-cache`, so a reload always lands on the new code. Nothing ever asked for that
 * reload, though: a phone keeps a tab alive for days, and a two-hour-old tab reported a
 * bug against code that had already been replaced, with the map redrawing sixteen
 * hundred vehicles every four seconds because that build still did.
 *
 * So the tab asks. Comparing the entry asset's filename is enough -- Vite fingerprints
 * it by content, so it changes exactly when the code does and not when a deploy ships
 * an identical bundle.
 */

/** Vite's fingerprinted entry module, the one filename that changes on every build. */
const ENTRY = /<script[^>]+\bsrc="(\/assets\/index-[^"]+\.js)"/;

/** The entry asset named by a served `index.html`, or null if it names none. */
export function entryAsset(html: string): string | null {
  return ENTRY.exec(html)?.[1] ?? null;
}

/** The entry asset this tab was loaded from. Null under the dev server, which has none. */
function loadedEntry(): string | null {
  for (const el of document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')) {
    const src = el.getAttribute("src");
    if (src && /^\/assets\/index-.+\.js$/.test(src)) return src;
  }
  return null;
}

/** While the tab is in front. Long, because a deploy is not something to poll for. */
const CHECK_INTERVAL_MS = 30 * 60_000;
/** Floor between checks, so flicking between apps is not a request each time. */
const MIN_GAP_MS = 60_000;

export function useNewVersion(): boolean {
  const [stale, setStale] = useState(false);
  const lastCheck = useRef(0);

  useEffect(() => {
    const loaded = loadedEntry();
    // Under the dev server there is no fingerprint to compare, and nothing to prompt
    // about: the page reloads itself on every save.
    if (!loaded || stale) return;

    let cancelled = false;

    const check = async () => {
      if (cancelled || document.hidden) return;
      if (Date.now() - lastCheck.current < MIN_GAP_MS) return;
      lastCheck.current = Date.now();
      try {
        const res = await fetch("/", { cache: "no-store", headers: { accept: "text/html" } });
        if (!res.ok) return;
        const served = entryAsset(await res.text());
        if (!cancelled && served && served !== loaded) setStale(true);
      } catch {
        // No signal. On a train that is most of the journey; the next check asks again.
      }
    };

    // On return rather than on load: a tab that has just started is by definition
    // current, and the interesting moment is picking the phone up hours later.
    const onVisibility = () => void check();
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
    };
  }, [stale]);

  return stale;
}
