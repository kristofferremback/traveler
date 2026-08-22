import type { Deviation, TransportMode } from "@traveler/shared";
import { getJson } from "./http.ts";
import { normaliseMode } from "./modes.ts";
import { severityFromImportance } from "./transport.ts";
import { toInstant } from "../lib/time.ts";

const BASE = "https://deviations.integration.sl.se/v1/messages";

type SlDeviation = {
  version?: number;
  created?: string | null;
  modified?: string | null;
  deviation_case_id: number;
  publish?: { from?: string | null; upto?: string | null } | null;
  priority?: {
    importance_level?: number | null;
    influence_level?: number | null;
    urgency_level?: number | null;
  } | null;
  message_variants?:
    | {
        header?: string | null;
        details?: string | null;
        scope_alias?: string | null;
        weblink?: string | null;
        language?: string | null;
      }[]
    | null;
  scope?: {
    stop_areas?: { id: number; name?: string | null; type?: string | null }[] | null;
    lines?:
      | {
          id: number;
          designation?: string | null;
          name?: string | null;
          transport_mode?: string | null;
          group_of_lines?: string | null;
        }[]
      | null;
  } | null;
  categories?: unknown;
};

export type DeviationFilter = {
  sites?: number[];
  lines?: number[];
  modes?: TransportMode[];
  future?: boolean;
};

/**
 * `site`, `line` and `transport_mode` repeat rather than taking a comma list, which
 * URLSearchParams.set would flatten into a single invalid value. Built by hand for that
 * reason.
 */
function buildUrl(filter: DeviationFilter): string {
  const url = new URL(BASE);
  if (filter.future) url.searchParams.set("future", "true");
  for (const site of filter.sites ?? []) url.searchParams.append("site", String(site));
  for (const line of filter.lines ?? []) url.searchParams.append("line", String(line));
  for (const mode of filter.modes ?? []) {
    if (mode !== "WALK" && mode !== "UNKNOWN") {
      url.searchParams.append("transport_mode", mode);
    }
  }
  return url.toString();
}

/** Swedish is the only language SL publishes today; the fallback keeps us honest if that changes. */
function pickVariant(deviation: SlDeviation, language = "sv") {
  const variants = deviation.message_variants ?? [];
  return (
    variants.find((v) => v.language === language) ??
    variants.find((v) => v.language === "sv") ??
    variants[0] ??
    null
  );
}

export async function fetchDeviations(
  filter: DeviationFilter = {},
): Promise<Deviation[]> {
  const raw = await getJson<SlDeviation[]>(buildUrl(filter), {
    upstream: "sl-deviations",
    timeoutMs: 10_000,
  });

  return raw
    .map((d): Deviation => {
      const variant = pickVariant(d);
      const importance = d.priority?.importance_level ?? 0;
      const areas = d.scope?.stop_areas ?? [];
      return {
        id: d.deviation_case_id,
        severity: severityFromImportance(importance),
        importance,
        header: variant?.header?.trim() || "Avvikelse",
        details: variant?.details?.trim() || "",
        weblink: variant?.weblink?.trim() || null,
        from: toInstant(d.publish?.from ?? null),
        upto: toInstant(d.publish?.upto ?? null),
        modified: toInstant(d.modified ?? d.created ?? null),
        lines: (d.scope?.lines ?? []).map((l) => ({
          id: l.id,
          designation: l.designation ?? String(l.id),
          name: l.name ?? null,
          mode: normaliseMode(l.transport_mode),
          groupOfLines: l.group_of_lines ?? null,
        })),
        stopAreaIds: areas.map((a) => a.id),
        stopAreaNames: areas.map((a) => a.name ?? "").filter(Boolean),
      };
    })
    .sort((a, b) => b.importance - a.importance);
}

const SEVERITY_ORDER = { info: 0, minor: 1, major: 2, severe: 3 } as const;

export function atLeast(
  deviation: Deviation,
  minimum: Deviation["severity"],
): boolean {
  return SEVERITY_ORDER[deviation.severity] >= SEVERITY_ORDER[minimum];
}
