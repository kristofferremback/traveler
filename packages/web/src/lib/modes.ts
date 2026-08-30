import type { TransportMode } from "@traveler/shared";
import { Bus, Car, Footprints, MapPin, Ship, TramFront, Train, TrainFront, type LucideProps } from "lucide-react";
import type { ComponentType } from "react";

export const MODE_LABEL: Record<TransportMode, string> = {
  BUS: "Buss",
  METRO: "Tunnelbana",
  TRAM: "Spårvagn",
  TRAIN: "Tåg",
  SHIP: "Båt",
  FERRY: "Färja",
  TAXI: "Närtrafik",
  WALK: "Gå",
  UNKNOWN: "Resa",
};

export const MODE_ICON: Record<TransportMode, ComponentType<LucideProps>> = {
  BUS: Bus,
  METRO: TrainFront,
  TRAM: TramFront,
  TRAIN: Train,
  SHIP: Ship,
  FERRY: Ship,
  TAXI: Car,
  WALK: Footprints,
  UNKNOWN: MapPin,
};

/**
 * What a traveller picks between when narrowing a search, in SL's own words.
 *
 * A second list beside `MODE_LABEL` rather than a reuse of it, because the two answer
 * different questions. `MODE_LABEL` names the mode of a leg you are already on, where
 * "Tåg" is right for both the pendeltåg and the Arlanda Express. This names a choice,
 * where the word on the sign is what people look for. Båt covers SHIP and FERRY: the
 * catalog tells a pier from a ferry berth and no traveller does.
 */
export type ModeFilter = { label: string; modes: TransportMode[] };

export const MODE_FILTERS: ModeFilter[] = [
  { label: "Tunnelbana", modes: ["METRO"] },
  { label: "Buss", modes: ["BUS"] },
  { label: "Pendeltåg", modes: ["TRAIN"] },
  { label: "Spårvagn", modes: ["TRAM"] },
  { label: "Båt", modes: ["SHIP", "FERRY"] },
];

/** Which filters a chosen set of modes covers. */
export function selectedFilters(modes: TransportMode[]): ModeFilter[] {
  return MODE_FILTERS.filter((f) => f.modes.some((m) => modes.includes(m)));
}

/**
 * The chosen set after one filter is turned on or off.
 *
 * Empty is the resting state and means every mode, so turning the last filter off lands
 * back there instead of on a search that can have no answer. Turning the last one *on*
 * lands there too: an allow-list naming every mode we offer would still exclude
 * närtrafik, which is not what "all of them" means to anyone.
 */
export function toggleMode(modes: TransportMode[], filter: ModeFilter): TransportMode[] {
  const on = filter.modes.some((m) => modes.includes(m));
  const next = on
    ? modes.filter((m) => !filter.modes.includes(m))
    : [...modes, ...filter.modes];
  const picked = selectedFilters(next);
  if (picked.length === MODE_FILTERS.length) return [];
  return MODE_FILTERS.flatMap((f) => (picked.includes(f) ? f.modes : []));
}

/** The `modes` search parameter read back, in the picker's order and without junk. */
export function parseModes(raw: string | null): TransportMode[] {
  if (!raw) return [];
  const asked = new Set(raw.split(","));
  const modes = MODE_FILTERS.flatMap((f) => f.modes).filter((m) => asked.has(m));
  return selectedFilters(modes).length === MODE_FILTERS.length ? [] : modes;
}

/**
 * What the pill says.
 *
 * Nothing picked is the whole network, and the pill then names the control rather than
 * the state, because that is the only thing on screen that tells you the choice exists.
 * "Utan buss" is spelled out rather than counted: leaving one mode out is a common
 * enough thing to want that it deserves to be readable at a glance.
 */
export function describeModes(modes: TransportMode[]): string {
  const picked = selectedFilters(modes);
  if (picked.length === 0 || picked.length === MODE_FILTERS.length) return "Färdmedel";
  const name = (f: ModeFilter) => f.label.toLowerCase();
  if (picked.length === MODE_FILTERS.length - 1) {
    const missing = MODE_FILTERS.find((f) => !picked.includes(f))!;
    return `Utan ${name(missing)}`;
  }
  if (picked.length === 1) return `Bara ${name(picked[0]!)}`;
  if (picked.length === 2) return `Bara ${name(picked[0]!)} och ${name(picked[1]!)}`;
  return `${picked.length} färdmedel`;
}

/**
 * SL's line colours, as concrete hex.
 *
 * Not CSS custom properties: MapLibre parses paint values itself and cannot resolve
 * `var(...)`, so a layer given one silently falls back to black. That is how the route
 * line ended up drawn as a black stripe with nothing logged. Hex also keeps the same
 * value in both themes, which is correct here -- a green line is green on the platform
 * sign whatever the phone is set to.
 */
const LINE_COLOR = {
  metroBlue: "#007db8",
  metroRed: "#d71d24",
  metroGreen: "#148541",
  train: "#b65ba3",
  tram: "#009aa4",
  bus: "#e1691c",
  ship: "#0074a8",
  walk: "#8a94a6",
  unknown: "#4c9be8",
} as const;

/** The metro splits three ways by line, which is why this takes a designation too. */
export function modeColor(mode: TransportMode, designation?: string | null): string {
  if (mode === "METRO") {
    const line = Number(designation);
    if (line === 13 || line === 14) return LINE_COLOR.metroRed;
    if (line === 17 || line === 18 || line === 19) return LINE_COLOR.metroGreen;
    return LINE_COLOR.metroBlue;
  }
  switch (mode) {
    case "TRAIN":
      return LINE_COLOR.train;
    case "TRAM":
      return LINE_COLOR.tram;
    case "BUS":
      return LINE_COLOR.bus;
    case "SHIP":
    case "FERRY":
      return LINE_COLOR.ship;
    case "WALK":
      return LINE_COLOR.walk;
    default:
      return LINE_COLOR.unknown;
  }
}
