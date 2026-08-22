import { logger } from "../lib/log.ts";
import { describe } from "../lib/errors.ts";

const log = logger("realtime");

export type Subscriber<T> = (value: T | null, error: string | null) => void;

/**
 * A polling source shared by every client watching the same thing.
 *
 * Two properties matter here. The poll only runs while someone is listening, so an
 * idle app costs SL nothing and costs a metered Trafiklab key nothing. And N clients
 * watching one stop produce one upstream request, not N -- the difference between
 * polite and abusive once this is on a phone that reconnects on every screen wake.
 *
 * The newest value is replayed to a joining subscriber immediately, so opening a board
 * shows data before the next tick rather than an empty list.
 */
export class PollingHub<T> {
  #subscribers = new Set<Subscriber<T>>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #latest: T | null = null;
  #latestAt = 0;
  #error: string | null = null;
  #inFlight = false;

  constructor(
    private readonly name: string,
    private readonly produce: () => Promise<T>,
    private readonly intervalMs: number,
    /** Replayed value older than this triggers an immediate refresh on subscribe. */
    private readonly staleMs = intervalMs,
  ) {}

  get subscriberCount() {
    return this.#subscribers.size;
  }

  subscribe(subscriber: Subscriber<T>): () => void {
    this.#subscribers.add(subscriber);

    if (this.#latest !== null || this.#error !== null) {
      subscriber(this.#latest, this.#error);
    }

    const stale = Date.now() - this.#latestAt > this.staleMs;
    if (stale) void this.#tick();
    this.#ensureTimer();

    return () => {
      this.#subscribers.delete(subscriber);
      if (this.#subscribers.size === 0) this.#stopTimer();
    };
  }

  #ensureTimer() {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#tick(), this.intervalMs);
  }

  #stopTimer() {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
    log.debug(`${this.name}: idle, polling stopped`);
  }

  async #tick() {
    // A slow upstream must not queue overlapping requests; skipping a tick is the
    // correct behaviour for a source that only ever reports "now".
    if (this.#inFlight) return;
    this.#inFlight = true;
    try {
      const value = await this.produce();
      this.#latest = value;
      this.#latestAt = Date.now();
      this.#error = null;
      for (const subscriber of this.#subscribers) subscriber(value, null);
    } catch (err) {
      const message = describe(err);
      this.#error = message;
      log.warn(`${this.name}: poll failed: ${message}`);
      // The last good value is kept and stays on screen; the error rides alongside it
      // so the UI can say "last updated 30s ago" instead of blanking the board.
      for (const subscriber of this.#subscribers) subscriber(this.#latest, message);
    } finally {
      this.#inFlight = false;
    }
  }
}

/**
 * A family of hubs keyed by, say, a site id. Hubs are discarded once their last
 * subscriber leaves so a long-running server does not accumulate one timer per stop
 * anybody ever looked at.
 */
export class HubRegistry<T> {
  #hubs = new Map<string, PollingHub<T>>();

  constructor(
    private readonly name: string,
    private readonly factory: (key: string) => () => Promise<T>,
    private readonly intervalMs: number,
  ) {}

  subscribe(key: string, subscriber: Subscriber<T>): () => void {
    let hub = this.#hubs.get(key);
    if (!hub) {
      hub = new PollingHub<T>(`${this.name}:${key}`, this.factory(key), this.intervalMs);
      this.#hubs.set(key, hub);
    }
    const unsubscribe = hub.subscribe(subscriber);
    return () => {
      unsubscribe();
      if (hub.subscriberCount === 0) this.#hubs.delete(key);
    };
  }

  get size() {
    return this.#hubs.size;
  }

  get subscriberCount() {
    let total = 0;
    for (const hub of this.#hubs.values()) total += hub.subscriberCount;
    return total;
  }
}
