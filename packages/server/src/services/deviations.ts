import type { DeviationsQuery, DeviationsResponse } from "@traveler/shared";
import type { Deviation } from "@traveler/shared";
import { atLeast, fetchDeviations } from "../sl/deviations.ts";
import { cached } from "../db/cache.ts";
import { PollingHub } from "../realtime/hub.ts";

function parseIds(raw: string | undefined): number[] | undefined {
  if (!raw) return undefined;
  const ids = raw
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : undefined;
}

export async function getDeviations(
  query: DeviationsQuery,
): Promise<DeviationsResponse> {
  const sites = parseIds(query.site);
  const lines = parseIds(query.line);

  const key = `deviations:${sites?.join("|") ?? ""}:${lines?.join("|") ?? ""}:${
    query.modes?.join("|") ?? ""
  }:${query.future}`;

  // SL explicitly asks for no more than one request a minute on this endpoint. The
  // cache is what makes that promise hold no matter how many clients are connected.
  const deviations = await cached(key, 60, () =>
    fetchDeviations({ sites, lines, modes: query.modes, future: query.future }),
  );

  return {
    deviations: deviations.filter((d) => atLeast(d, query.minSeverity)),
    fetchedAt: new Date().toISOString(),
  };
}

const EMPTY_QUERY: DeviationsQuery = {
  site: undefined,
  line: undefined,
  modes: undefined,
  future: false,
  minSeverity: "info",
};

/**
 * The network-wide feed is polled once and narrowed per subscriber, so a stream can
 * honour site, line, mode and severity filters without turning each viewer into
 * another request against an endpoint SL asks us to hit once a minute.
 */
const networkFeed = new PollingHub<DeviationsResponse>(
  "deviations",
  () => getDeviations(EMPTY_QUERY),
  60_000,
);

function narrow(deviations: Deviation[], query: DeviationsQuery): Deviation[] {
  const sites = new Set(parseIds(query.site) ?? []);
  const lines = new Set(parseIds(query.line) ?? []);
  const modes = query.modes?.length ? new Set(query.modes) : null;

  return deviations.filter((d) => {
    if (!atLeast(d, query.minSeverity)) return false;
    if (sites.size > 0 && !d.stopAreaIds.some((id) => sites.has(id))) return false;
    if (lines.size > 0 && !d.lines.some((l) => l.id !== null && lines.has(l.id))) return false;
    if (modes && !d.lines.some((l) => modes.has(l.mode))) return false;
    return true;
  });
}

export function subscribeToDeviations(
  query: DeviationsQuery,
  subscriber: (value: DeviationsResponse | null, error: string | null) => void,
) {
  return networkFeed.subscribe((value, error) => {
    if (!value) {
      subscriber(null, error);
      return;
    }
    subscriber({ ...value, deviations: narrow(value.deviations, query) }, error);
  });
}
