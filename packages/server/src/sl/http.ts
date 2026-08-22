import { UpstreamError, describe } from "../lib/errors.ts";
import { logger } from "../lib/log.ts";
import { VERSION } from "../env.ts";

const log = logger("sl-http");

const USER_AGENT = `Traveler/${VERSION} (+personal SL journey planner)`;

export type FetchOptions = {
  upstream: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  timeoutMs?: number;
  retries?: number;
  accept?: string;
};

function buildUrl(base: string, query: FetchOptions["query"]): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

async function request(url: string, opts: FetchOptions): Promise<Response> {
  const { upstream, timeoutMs = 12_000, retries = 2, accept = "application/json" } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 300ms, 900ms -- long enough to clear a blip, short enough that a phone user
      // sees an error rather than a spinner that never resolves.
      await Bun.sleep(300 * 3 ** (attempt - 1));
    }
    try {
      const res = await fetch(url, {
        headers: { accept, "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;

      const body = await res.text().catch(() => "");
      if (RETRYABLE.has(res.status) && attempt < retries) {
        log.warn(`${upstream} ${res.status}, retrying (attempt ${attempt + 1})`);
        lastError = new UpstreamError(upstream, `${res.status} ${res.statusText}`);
        continue;
      }
      // SL's gateway returns a JSON body naming the offending parameter. Surfacing it
      // verbatim turns an opaque 400 into an actionable one.
      throw new UpstreamError(
        upstream,
        `${upstream} responded ${res.status}: ${body.slice(0, 400) || res.statusText}`,
        res.status >= 400 && res.status < 500 ? 400 : 502,
      );
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 400) throw err;
      lastError = err;
      if (attempt >= retries) break;
      log.warn(`${upstream} failed, retrying: ${describe(err)}`);
    }
  }
  throw new UpstreamError(upstream, `${upstream} unreachable: ${describe(lastError)}`);
}

export async function getJson<T>(base: string, opts: FetchOptions): Promise<T> {
  const url = buildUrl(base, opts.query);
  const started = Bun.nanoseconds();
  const res = await request(url, opts);
  const json = (await res.json()) as T;
  log.debug(
    `${opts.upstream} ok in ${Math.round((Bun.nanoseconds() - started) / 1e6)}ms`,
  );
  return json;
}

/** Raw body, for responses that must be pre-processed before parsing (see `bigid.ts`). */
export async function getText(base: string, opts: FetchOptions): Promise<string> {
  const url = buildUrl(base, opts.query);
  const res = await request(url, opts);
  return res.text();
}

export async function getBuffer(base: string, opts: FetchOptions): Promise<Uint8Array> {
  const url = buildUrl(base, opts.query);
  const res = await request(url, { ...opts, accept: opts.accept ?? "*/*" });
  return new Uint8Array(await res.arrayBuffer());
}
