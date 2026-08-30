import type {
  CommuteResponse,
  CommuteSettings,
  DeparturesResponse,
  DeviationsResponse,
  HealthResponse,
  Journey,
  JourneyResponse,
  InviteResponse,
  MeResponse,
  SignInMethodsResponse,
  Neighbourhood,
  Place,
  SavedPlace,
  SavedPlaceInput,
  SavedPlacePatch,
  UserSettingsPatch,
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

/**
 * A session that expired mid-use looks like every request suddenly failing, which is a
 * confusing way to be signed out. Send the person to the sign-in page instead.
 *
 * Guarded twice: the flag stops a screenful of parallel queries from each starting a
 * navigation, and the path check stops the sign-in page itself from reloading forever
 * when something there reads the API.
 */
let redirectingToSignIn = false;

function onUnauthenticated() {
  if (redirectingToSignIn) return;
  if (window.location.pathname === "/signin") return;
  redirectingToSignIn = true;
  window.location.assign("/signin");
}

async function failure(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | null;
  if (res.status === 401) onUnauthenticated();
  return new ApiError(
    body?.error?.code ?? "http_error",
    // The server's message is written for a person to read, so it goes straight
    // through rather than being replaced with a generic string.
    body?.error?.message ?? `Request failed (${res.status})`,
    res.status,
  );
}

async function get<T>(path: string, params: Params = {}, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}/api${path}${query(params)}`, { signal });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

async function send<T>(method: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

/** A 204 has no body to parse, so this one returns nothing rather than `unknown`. */
async function remove(path: string): Promise<void> {
  const res = await fetch(`${BASE}/api${path}`, { method: "DELETE" });
  if (!res.ok) throw await failure(res);
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

  /**
   * Door-to-door options between two places. `from`/`to` are place ids, "lat,lon", or
   * "place:<id>" for a saved place. `paths` decides how much drawn geometry comes back;
   * the default carries only the recommended option's.
   */
  commute: (
    params: {
      from: string;
      to: string;
      when?: string;
      arriveBy?: "1";
      modes?: string;
      paths?: "recommended" | "all" | "none";
    },
    signal?: AbortSignal,
  ) => get<CommuteResponse>("/commute", params, signal),

  deviations: (
    params: { site?: string; line?: string; modes?: string; minSeverity?: string },
    signal?: AbortSignal,
  ) => get<DeviationsResponse>("/deviations", params, signal),

  vehicles: (params: { bbox: string; modes?: string }, signal?: AbortSignal) =>
    get<VehiclesResponse>("/vehicles", params, signal),

  me: (signal?: AbortSignal) => get<MeResponse>("/me", {}, signal),

  signInMethods: () => get<SignInMethodsResponse>("/sign-in-methods"),
  createInvite: (body: { email: string; name?: string }) =>
    send<InviteResponse>("POST", "/invites", body),

  places: {
    list: (signal?: AbortSignal) => get<{ places: SavedPlace[] }>("/places", {}, signal),
    create: (body: SavedPlaceInput) => send<{ place: SavedPlace }>("POST", "/places", body),
    get: (id: number, signal?: AbortSignal) =>
      get<{ place: SavedPlace }>(`/places/${id}`, {}, signal),
    patch: (id: number, body: SavedPlacePatch) =>
      send<{ place: SavedPlace }>("PATCH", `/places/${id}`, body),
    delete: (id: number) => remove(`/places/${id}`),
    neighbourhood: (
      id: number,
      params: { isochrones?: boolean; speedKmh?: number; maxWalkMinutes?: number } = {},
      signal?: AbortSignal,
    ) => get<Neighbourhood>(`/places/${id}/neighbourhood`, params, signal),
  },

  settings: {
    get: (signal?: AbortSignal) => get<{ settings: CommuteSettings }>("/settings", {}, signal),
    put: (body: UserSettingsPatch) =>
      send<{ settings: CommuteSettings }>("PUT", "/settings", body),
  },
};

/** Stream URLs, for the SSE hook. */
export const streams = {
  departures: (siteId: number, params: Params) =>
    `${BASE}/api/sites/${siteId}/departures/stream${query(params)}`,
  deviations: (params: Params = {}) => `${BASE}/api/deviations/stream${query(params)}`,
  vehicles: (params: Params) => `${BASE}/api/vehicles/stream${query(params)}`,
};

export type { Journey, Place };
