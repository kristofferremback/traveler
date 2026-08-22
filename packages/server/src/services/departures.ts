import type { Departure, DeparturesQuery, DeparturesResponse } from "@traveler/shared";
import { getSite } from "../db/catalog.ts";
import { fetchDepartures } from "../sl/transport.ts";
import { HubRegistry } from "../realtime/hub.ts";

/**
 * Apply the caller's filters to an already-fetched board.
 *
 * Filtering locally rather than upstream is what lets every viewer of a stop share one
 * poll regardless of which modes or line each of them chose. It also sidesteps SL's
 * `transport` parameter accepting only a single value.
 */
export function filterDepartures(
  departures: Departure[],
  query: Pick<DeparturesQuery, "modes" | "line" | "direction">,
): Departure[] {
  const modes = query.modes?.length ? new Set(query.modes) : null;
  const line = query.line?.trim().toLowerCase();

  return departures.filter((d) => {
    if (modes && !modes.has(d.line.mode)) return false;
    if (line && d.line.designation.toLowerCase() !== line) return false;
    if (query.direction !== undefined && d.directionCode !== query.direction) return false;
    return true;
  });
}

async function fetchBoard(
  siteId: number,
  forecast: number,
): Promise<DeparturesResponse> {
  const { departures, stopDeviations } = await fetchDepartures(siteId, { forecast });
  const site = getSite(siteId);
  return {
    siteId,
    siteGid: site?.gid ?? null,
    siteName: site?.name ?? null,
    fetchedAt: new Date().toISOString(),
    departures,
    deviations: stopDeviations,
  };
}

export async function getDepartures(
  siteId: number,
  query: DeparturesQuery,
): Promise<DeparturesResponse> {
  const board = await fetchBoard(siteId, query.forecast);
  return { ...board, departures: filterDepartures(board.departures, query) };
}

/**
 * Live boards refresh every 15 s.
 *
 * SL recomputes realtime estimates roughly that often, so polling faster spends
 * requests on identical payloads. The hub is keyed only by site and forecast window --
 * the unfiltered board -- so ten people watching Slussen with ten different mode
 * filters still produce one upstream request.
 */
const REFRESH_MS = 15_000;

const boards = new HubRegistry<DeparturesResponse>(
  "departures",
  (key) => {
    const [siteId, forecast] = key.split(":");
    return () => fetchBoard(Number(siteId), Number(forecast));
  },
  REFRESH_MS,
);

export function subscribeToDepartures(
  siteId: number,
  query: DeparturesQuery,
  subscriber: (value: DeparturesResponse | null, error: string | null) => void,
) {
  return boards.subscribe(`${siteId}:${query.forecast}`, (value, error) => {
    if (!value) {
      subscriber(null, error);
      return;
    }
    subscriber({ ...value, departures: filterDepartures(value.departures, query) }, error);
  });
}

export function departureSubscriberCount() {
  return boards.subscriberCount;
}
