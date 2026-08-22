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
