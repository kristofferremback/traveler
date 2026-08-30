import { useEffect, useState } from "react";

export type StreamState<T> = {
  data: T | null;
  error: string | null;
  /** True once a message has arrived, so the UI can tell "connecting" from "empty". */
  connected: boolean;
  /** When the last payload arrived, for a "last updated" line during an outage. */
  updatedAt: number | null;
};

const EMPTY: StreamState<never> = {
  data: null,
  error: null,
  connected: false,
  updatedAt: null,
};

/** Server-sent payload errors. Not "error", which EventSource reserves for the transport. */
const SERVER_ERROR_EVENT = "stream-error";

/**
 * Subscribe to one of the server's SSE endpoints.
 *
 * EventSource reconnects on its own, which is most of why the streams are SSE. The one
 * thing it does not do is tell you it has stopped delivering while it retries, so the
 * last payload and its timestamp are kept and handed back alongside any error. A board
 * that has gone stale keeps showing its last departures with a visible timestamp rather
 * than blanking, which is the more useful failure on a train losing signal.
 *
 * State resets when `url` changes. Carrying it over would leave one stop's departures
 * on screen under another stop's heading until the new stream first emits.
 *
 * A hidden tab holds no connection. A board left open in a pocket has nobody reading it,
 * and its stream is a poll upstream for as long as the tab exists -- and after a deploy
 * it is a reconnect every few seconds, for good. The last payload stays on screen with
 * its timestamp, so coming back shows the board that was there and then refreshes it.
 */
export function useStream<T>(url: string | null, event: string): StreamState<T> {
  const [state, setState] = useState<StreamState<T>>(EMPTY);
  const [visible, setVisible] = useState(() => !document.hidden);

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // A new stream is a new subject, so nothing from the old one is kept. Separate from
  // the connection below, which also runs when the tab comes back and must not blank
  // the screen when it does.
  useEffect(() => setState(EMPTY), [url]);

  useEffect(() => {
    if (!url || !visible) return;

    const source = new EventSource(url);

    const onMessage = (e: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(e.data) as T;
        setState({ data: parsed, error: null, connected: true, updatedAt: Date.now() });
      } catch {
        setState((prev) => ({ ...prev, error: "Kunde inte läsa uppdateringen." }));
      }
    };

    const onServerError = (e: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(e.data) as { message?: string };
        setState((prev) => ({ ...prev, error: parsed.message ?? "Ett fel uppstod." }));
      } catch {
        setState((prev) => ({ ...prev, error: "Ett fel uppstod." }));
      }
    };

    const onTransportError = () => {
      // EventSource retries by itself; keep whatever was last shown.
      setState((prev) => ({
        ...prev,
        connected: false,
        error: prev.data ? "Återansluter." : "Ingen anslutning.",
      }));
    };

    source.addEventListener(event, onMessage as EventListener);
    source.addEventListener(SERVER_ERROR_EVENT, onServerError as EventListener);
    source.addEventListener("error", onTransportError);

    return () => {
      source.removeEventListener(event, onMessage as EventListener);
      source.removeEventListener(SERVER_ERROR_EVENT, onServerError as EventListener);
      source.removeEventListener("error", onTransportError);
      source.close();
    };
  }, [url, event, visible]);

  return state;
}
