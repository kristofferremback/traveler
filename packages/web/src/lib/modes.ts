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
 * SL's own colours, because a Stockholmer reads the colour before the number. The metro
 * splits three ways by line, which is why this takes a designation and not just a mode.
 */
export function modeColor(mode: TransportMode, designation?: string | null): string {
  if (mode === "METRO") {
    const line = Number(designation);
    if (line === 10 || line === 11) return "var(--color-metro-blue)";
    if (line === 13 || line === 14) return "var(--color-metro-red)";
    if (line === 17 || line === 18 || line === 19) return "var(--color-metro-green)";
    return "var(--color-metro-blue)";
  }
  switch (mode) {
    case "TRAIN":
      return "var(--color-train)";
    case "TRAM":
      return "var(--color-tram)";
    case "BUS":
      return "var(--color-bus)";
    case "SHIP":
    case "FERRY":
      return "var(--color-ship)";
    case "WALK":
      return "var(--color-muted)";
    default:
      return "var(--color-accent)";
  }
}
