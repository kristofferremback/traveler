import type { Departure, DepartureState, Deviation, TransportMode } from "@traveler/shared";
import { getJson, getText } from "./http.ts";
import { SL_ID_KEYS, parseJsonPreservingIds } from "../lib/bigid.ts";
import { normaliseMode } from "./modes.ts";
import { parseSlTime, secondsBetween, toInstant } from "../lib/time.ts";

const BASE = "https://transport.integration.sl.se/v1";

// ---------------------------------------------------------------------------
// Upstream shapes. Hand-written rather than zod-validated: the catalog endpoints
// return 8 MB of objects and we read a stable handful of fields from each.
// ---------------------------------------------------------------------------

type Validity = { from?: string | null; upto?: string | null };

export type SlSite = {
  id: number;
  /** String, not number -- see `lib/bigid.ts`. Sixteen digits do not survive a double. */
  gid: string;
  name: string;
  note?: string | null;
  abbreviation?: string | null;
  alias?: string[] | null;
  lat: number;
  lon: number;
  stop_areas?: number[] | null;
  valid?: Validity | null;
};

export type SlStopPoint = {
  id: number;
  gid: string;
  name: string;
  sname?: string | null;
  designation?: string | null;
  type?: string | null;
  lat?: number | null;
  lon?: number | null;
  has_entrance?: boolean | null;
  stop_area?: { id: number; name?: string | null; type?: string | null } | null;
  valid?: Validity | null;
};

export type SlLine = {
  id: number;
  gid: string;
  name?: string | null;
  designation: string;
  transport_mode: string;
  group_of_lines?: string | null;
  transport_authority?: { id: number; name?: string | null } | null;
  contractor?: { id: number; name?: string | null } | null;
  valid?: Validity | null;
};

export type SlTransportAuthority = {
  id: number;
  gid: string;
  name: string;
  formal_name?: string | null;
  code?: string | null;
};

type SlDeparture = {
  destination?: string | null;
  direction?: string | null;
  direction_code?: number | null;
  state?: string | null;
  display?: string | null;
  scheduled?: string | null;
  expected?: string | null;
  journey?: { id?: number | null; state?: string | null } | null;
  stop_area?: { id?: number; name?: string | null; type?: string | null } | null;
  stop_point?: { id?: number; name?: string | null; designation?: string | null } | null;
  line?: {
    id?: number | null;
    designation?: string | null;
    transport_mode?: string | null;
    group_of_lines?: string | null;
  } | null;
  deviations?: { message?: string | null; importance_level?: number | null }[] | null;
};

type SlStopDeviation = {
  id: number;
  importance_level?: number | null;
  message?: string | null;
  scope?: { stop_areas?: { id: number; name?: string | null }[] | null } | null;
};

type SlDeparturesResponse = {
  departures?: SlDeparture[] | null;
  stop_deviations?: SlStopDeviation[] | null;
};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** Catalog endpoints carry `gid`, so they are parsed with the id-preserving reader. */
async function getCatalog<T>(url: string, upstream: string, timeoutMs: number, query?: Record<string, string | number>): Promise<T> {
  const text = await getText(url, { upstream, timeoutMs, query });
  return parseJsonPreservingIds<T>(text, SL_ID_KEYS);
}

export function fetchSites(): Promise<SlSite[]> {
  return getCatalog<SlSite[]>(`${BASE}/sites`, "sl-transport/sites", 60_000, {
    expand: "true",
  });
}

export function fetchStopPoints(): Promise<SlStopPoint[]> {
  return getCatalog<SlStopPoint[]>(
    `${BASE}/stop-points`,
    "sl-transport/stop-points",
    90_000,
  );
}

/** Lines come back grouped by mode rather than as a flat array. */
export async function fetchLines(transportAuthorityId: number): Promise<SlLine[]> {
  const grouped = await getCatalog<Record<string, SlLine[] | undefined>>(
    `${BASE}/lines`,
    "sl-transport/lines",
    30_000,
    { transport_authority_id: transportAuthorityId },
  );
  return Object.values(grouped).flatMap((lines) => lines ?? []);
}

export function fetchTransportAuthorities(): Promise<SlTransportAuthority[]> {
  return getCatalog<SlTransportAuthority[]>(
    `${BASE}/transport-authorities`,
    "sl-transport/transport-authorities",
    15_000,
  );
}

// ---------------------------------------------------------------------------
// Departures
// ---------------------------------------------------------------------------

function departureState(raw: string | null | undefined): DepartureState {
  switch ((raw ?? "").toUpperCase()) {
    case "EXPECTED":
      return "EXPECTED";
    case "ATSTOP":
      return "ATSTOP";
    case "DEPARTED":
      return "DEPARTED";
    case "CANCELLED":
    case "NOTEXPECTED":
      return "CANCELLED";
    default:
      return "UNKNOWN";
  }
}

export type DeparturesResult = {
  departures: Departure[];
  stopDeviations: Deviation[];
};

export async function fetchDepartures(
  siteId: number,
  opts: { forecast?: number; modes?: TransportMode[]; line?: string; direction?: number } = {},
): Promise<DeparturesResult> {
  const raw = await getJson<SlDeparturesResponse>(`${BASE}/sites/${siteId}/departures`, {
    upstream: "sl-transport/departures",
    query: {
      forecast: opts.forecast,
      line: opts.line,
      direction: opts.direction,
      // `transport` takes one value; broader filtering happens locally so that a
      // multi-mode request still costs exactly one upstream call.
      transport:
        opts.modes?.length === 1 && opts.modes[0] !== "WALK" ? opts.modes[0] : undefined,
    },
    timeoutMs: 10_000,
  });

  const wanted = opts.modes?.length ? new Set(opts.modes) : null;

  const departures: Departure[] = [];
  for (const [index, d] of (raw.departures ?? []).entries()) {
    const mode = normaliseMode(d.line?.transport_mode);
    if (wanted && !wanted.has(mode)) continue;

    const scheduled = toInstant(d.scheduled);
    if (!scheduled) continue; // A departure without a time is not a departure.
    const expected = toInstant(d.expected);

    departures.push({
      // Journey id repeats across a site's platforms, so the stop point is part of the key.
      key: `${d.journey?.id ?? "j"}:${d.stop_point?.id ?? "p"}:${d.scheduled ?? index}`,
      destination: d.destination ?? "",
      direction: d.direction ?? null,
      directionCode: d.direction_code ?? null,
      display: d.display ?? "",
      state: departureState(d.state ?? d.journey?.state),
      scheduled,
      expected,
      delaySeconds: expected ? secondsBetween(scheduled, expected) : null,
      line: {
        id: d.line?.id ?? null,
        designation: d.line?.designation ?? "",
        name: d.line?.group_of_lines ?? null,
        mode,
        groupOfLines: d.line?.group_of_lines ?? null,
      },
      stopAreaName: d.stop_area?.name ?? null,
      stopPointName: d.stop_point?.name ?? null,
      platform: d.stop_point?.designation ?? null,
      journeyId: d.journey?.id ?? null,
      deviationNotes: (d.deviations ?? [])
        .map((x) => x.message?.trim())
        .filter((m): m is string => Boolean(m)),
    });
  }

  departures.sort(
    (a, b) =>
      new Date(a.expected ?? a.scheduled).getTime() -
      new Date(b.expected ?? b.scheduled).getTime(),
  );

  const stopDeviations: Deviation[] = (raw.stop_deviations ?? []).map((d) => {
    const importance = d.importance_level ?? 0;
    const areas = d.scope?.stop_areas ?? [];
    return {
      id: d.id,
      severity: severityFromImportance(importance),
      importance,
      header: (d.message ?? "").split("\n")[0]?.trim() || "Avvikelse",
      details: d.message ?? "",
      weblink: null,
      from: null,
      upto: null,
      modified: null,
      lines: [],
      stopAreaIds: areas.map((a) => a.id),
      stopAreaNames: areas.map((a) => a.name ?? "").filter(Boolean),
    };
  });

  return { departures, stopDeviations };
}

/**
 * SL grades disruptions 1..10 on several axes and publishes no thresholds. These
 * buckets are chosen so the UI can decide "is this worth interrupting someone for"
 * without every caller re-inventing a cutoff.
 */
export function severityFromImportance(level: number): Deviation["severity"] {
  if (level >= 7) return "severe";
  if (level >= 5) return "major";
  if (level >= 3) return "minor";
  return "info";
}

export { parseSlTime };
