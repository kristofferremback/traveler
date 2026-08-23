import type { SavedPlaceKind } from "@traveler/shared";
import { Building2, Landmark, LocateFixed, MapPin, type LucideProps } from "lucide-react";
import type { ComponentType } from "react";

/**
 * What kind of thing a saved place points at.
 *
 * A saved place has no mode of its own -- "Hem" is a stop, an address or a coordinate,
 * not a bus -- so it gets its own small set rather than borrowing `MODE_ICON`, which
 * would render every kind as the same pin.
 */
export const KIND_ICON: Record<SavedPlaceKind, ComponentType<LucideProps>> = {
  stop: MapPin,
  address: Building2,
  poi: Landmark,
  coordinate: LocateFixed,
};

export const KIND_LABEL: Record<SavedPlaceKind, string> = {
  stop: "Hållplats",
  address: "Adress",
  poi: "Plats",
  coordinate: "Koordinat",
};
