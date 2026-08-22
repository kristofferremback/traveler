import type { TransportMode } from "@traveler/shared";

/** SL Transport `transport_mode` and deviation `transport_mode` share this vocabulary. */
export function normaliseMode(raw: string | null | undefined): TransportMode {
  switch ((raw ?? "").toUpperCase()) {
    case "BUS":
      return "BUS";
    case "METRO":
      return "METRO";
    case "TRAM":
      return "TRAM";
    case "TRAIN":
      return "TRAIN";
    case "SHIP":
      return "SHIP";
    case "FERRY":
      return "FERRY";
    case "TAXI":
      return "TAXI";
    default:
      return "UNKNOWN";
  }
}

/** Stop-area types are the only per-site mode signal SL publishes. */
export function modeFromStopAreaType(raw: string | null | undefined): TransportMode {
  switch ((raw ?? "").toUpperCase()) {
    case "BUSTERM":
      return "BUS";
    case "METROSTN":
      return "METRO";
    case "TRAMSTN":
      return "TRAM";
    case "RAILWSTN":
      return "TRAIN";
    case "SHIPBER":
      return "SHIP";
    case "FERRYBER":
      return "FERRY";
    default:
      return "UNKNOWN";
  }
}

/**
 * The journey planner is an EFA instance and speaks product classes instead. The
 * mapping is documented nowhere; every entry below was read off live responses.
 *
 *   0  pendeltåg (Arlanda C, Stockholm City)   14  long-distance train
 *   2  tunnelbana                              19  närtrafik
 *   4  spårväg -- Nockeby-, Saltsjö-,          99  footpath (transfer)
 *      Roslagsbanan and Spårväg City          100  footpath (to/from the network)
 *   5  buss                                    9  båt
 *
 * Note that class 4 covers SL's light rail lines, which the SL Transport API calls
 * TRAM. They agree; they just say it differently.
 */
export function modeFromProductClass(cls: number | null | undefined): TransportMode {
  switch (cls) {
    case 0:
    case 1:
    case 13:
    case 14:
    case 15:
    case 16:
      return "TRAIN";
    case 2:
      return "METRO";
    case 3:
    case 4:
      return "TRAM";
    case 5:
    case 6:
    case 7:
    case 19:
      return "BUS";
    case 9:
      return "SHIP";
    case 10:
    case 11:
    case 12:
      return "TAXI";
    case 98:
    case 99:
    case 100:
      return "WALK";
    default:
      return "UNKNOWN";
  }
}

/** Reverse mapping, for the `incl_mot_*` trip filters. */
const MODE_TO_MOT: Partial<Record<TransportMode, number[]>> = {
  TRAIN: [0, 14],
  METRO: [2],
  TRAM: [4],
  BUS: [5, 19],
  SHIP: [9],
  FERRY: [9],
  TAXI: [10],
};

/** Every `incl_mot_*` the /trips endpoint accepts. */
export const ALL_MOT = [0, 2, 4, 5, 9, 10, 14, 19] as const;

/**
 * Turn a mode allow-list into explicit `incl_mot_*` flags.
 *
 * Both directions are set explicitly rather than relying on defaults: SL defaults every
 * flag to true, so omitting the excluded ones would silently widen the search instead of
 * narrowing it, and the user would get results they asked not to see.
 */
export function motFlags(modes: TransportMode[] | undefined): Record<string, boolean> {
  if (!modes || modes.length === 0) return {};
  const wanted = new Set(modes.flatMap((m) => MODE_TO_MOT[m] ?? []));
  return Object.fromEntries(ALL_MOT.map((mot) => [`incl_mot_${mot}`, wanted.has(mot)]));
}

/** EFA emits `[lat, lon]`; GeoJSON, MapLibre and everything downstream want `[lon, lat]`. */
export function toLonLat(pair: readonly number[]): [number, number] | null {
  const lat = pair[0];
  const lon = pair[1];
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  return [lon, lat];
}
