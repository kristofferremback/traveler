import type {
  DeparturesResponse,
  DeviationsResponse,
  HealthResponse,
  Journey,
  JourneyResponse,
  Place,
  VehiclesResponse,
} from "@traveler/shared";

const BASE = import.meta.env.VITE_API_BASE ?? "";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Params = Record<string, string | number | boolean | undefined | null>;

function query(params: Params): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

async function get<T>(path: string, params: Params = {}, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}/api${path}${query(params)}`, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new ApiError(
      body?.error?.code ?? "http_error",
      // The server's message is written for a person to read, so it goes straight
      // through rather than being replaced with a generic string.
      body?.error?.message ?? `Request failed (${res.status})`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

export const api = {
  health: (signal?: AbortSignal) => get<HealthResponse>("/health", {}, signal),

  searchPlaces: (
    params: { q: string; limit?: number; kinds?: string; lat?: number; lon?: number },
    signal?: AbortSignal,
  ) => get<{ places: Place[] }>("/places/search", params, signal),

  nearby: (
    params: { lat: number; lon: number; radius?: number; limit?: number; modes?: string },
    signal?: AbortSignal,
  ) => get<{ places: Place[] }>("/places/nearby", params, signal),

  locate: (params: { lat: number; lon: number }, signal?: AbortSignal) =>
    get<{ place: Place | null; places: Place[] }>("/places/locate", params, signal),

  resolvePlace: (id: string, signal?: AbortSignal) =>
    get<{ place: Place }>("/places/resolve", { id }, signal),

  site: (siteId: number, signal?: AbortSignal) =>
    get<{ place: Place }>(`/sites/${siteId}`, {}, signal),

  departures: (
    siteId: number,
    params: { forecast?: number; modes?: string; line?: string },
    signal?: AbortSignal,
  ) => get<DeparturesResponse>(`/sites/${siteId}/departures`, params, signal),

  journeys: (
    params: {
      from: string;
      to: string;
      via?: string;
      when?: string;
      arriveBy?: boolean;
      results?: number;
      maxChanges?: number;
      prefer?: string;
      modes?: string;
    },
    signal?: AbortSignal,
  ) => get<JourneyResponse>("/journeys", params, signal),

  deviations: (
    params: { site?: string; line?: string; modes?: string; minSeverity?: string },
    signal?: AbortSignal,
  ) => get<DeviationsResponse>("/deviations", params, signal),

  vehicles: (params: { bbox: string; modes?: string }, signal?: AbortSignal) =>
    get<VehiclesResponse>("/vehicles", params, signal),
};

/** Stream URLs, for the SSE hook. */
export const streams = {
  departures: (siteId: number, params: Params) =>
    `${BASE}/api/sites/${siteId}/departures/stream${query(params)}`,
  deviations: (params: Params = {}) => `${BASE}/api/deviations/stream${query(params)}`,
  vehicles: (params: Params) => `${BASE}/api/vehicles/stream${query(params)}`,
};

export type { Journey, Place };
