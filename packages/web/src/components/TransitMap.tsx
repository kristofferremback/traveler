import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type LngLatBoundsLike, type Map as MapLibreMap } from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";
import { Protocol } from "pmtiles";
import type { Journey, VehiclesResponse } from "@traveler/shared";
import { streams } from "@/lib/api";
import { useStream } from "@/hooks/useStream";
import { modeColor } from "@/lib/modes";
import "maplibre-gl/dist/maplibre-gl.css";

/**
 * The pmtiles protocol handler is registered once per document. MapLibre resolves
 * `pmtiles://` URLs through it, which is what lets the browser read a single archive on
 * the server's volume with range requests instead of talking to a tile service.
 */
let protocolRegistered = false;
function registerProtocol() {
  if (protocolRegistered) return;
  maplibregl.addProtocol("pmtiles", new Protocol().tile);
  protocolRegistered = true;
}

const STOCKHOLM_CENTRE: [number, number] = [18.0686, 59.3293];
const ROUTE_SOURCE = "journey-route";
const STOP_SOURCE = "journey-stops";
const VEHICLE_SOURCE = "vehicles";

function routeGeoJSON(journey: Journey | null): FeatureCollection {
  if (!journey) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: journey.legs
      .filter((leg) => leg.path.length > 1)
      .map((leg) => ({
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: leg.path },
        properties: {
          color: modeColor(leg.mode, leg.line?.designation),
          walking: leg.mode === "WALK",
        },
      })),
  };
}

function stopsGeoJSON(journey: Journey | null): FeatureCollection {
  if (!journey) return { type: "FeatureCollection", features: [] };
  const features: Feature[] = [];
  for (const leg of journey.legs) {
    for (const point of [leg.origin, leg.destination]) {
      if (point.lat === null || point.lon === null) continue;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [point.lon, point.lat] },
        properties: { name: point.name },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

function boundsOf(journey: Journey): LngLatBoundsLike | null {
  const coords = journey.legs.flatMap((leg) => leg.path);
  if (coords.length === 0) return null;
  const bounds = new maplibregl.LngLatBounds(coords[0], coords[0]);
  for (const c of coords) bounds.extend(c);
  return bounds;
}

export function TransitMap({
  journey,
  showVehicles = false,
  className,
}: {
  journey?: Journey | null;
  showVehicles?: boolean;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [bbox, setBbox] = useState<string | null>(null);
  const [styleError, setStyleError] = useState(false);

  useEffect(() => {
    if (!container.current || map.current) return;
    registerProtocol();

    const instance = new maplibregl.Map({
      container: container.current,
      style: import.meta.env.VITE_MAP_STYLE || "/api/map/style.json",
      center: STOCKHOLM_CENTRE,
      zoom: 11,
      attributionControl: { compact: true },
      // Vehicle markers and route lines are the content; tilting only makes them
      // harder to read on a phone.
      pitchWithRotate: false,
      dragRotate: false,
    });

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    instance.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
      }),
      "top-right",
    );

    instance.on("error", (e) => {
      // A missing basemap should not take the route lines with it.
      if (String(e.error?.message ?? "").includes("style")) setStyleError(true);
    });

    instance.on("load", () => {
      instance.addSource(ROUTE_SOURCE, { type: "geojson", data: routeGeoJSON(null) });
      instance.addSource(STOP_SOURCE, { type: "geojson", data: stopsGeoJSON(null) });
      instance.addSource(VEHICLE_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // A wide dark casing under the coloured line keeps it legible over both water
      // and built-up areas without needing a second basemap.
      instance.addLayer({
        id: "route-casing",
        type: "line",
        source: ROUTE_SOURCE,
        paint: { "line-color": "#0b1220", "line-width": 7, "line-opacity": 0.5 },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      instance.addLayer({
        id: "route-line",
        type: "line",
        source: ROUTE_SOURCE,
        paint: {
          "line-color": ["get", "color"],
          "line-width": 4,
          "line-dasharray": ["case", ["get", "walking"], ["literal", [1, 1.6]], ["literal", [1]]],
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      instance.addLayer({
        id: "route-stops",
        type: "circle",
        source: STOP_SOURCE,
        paint: {
          "circle-radius": 4,
          "circle-color": "#ffffff",
          "circle-stroke-color": "#0b1220",
          "circle-stroke-width": 2,
        },
      });
      instance.addLayer({
        id: "vehicle-dots",
        type: "circle",
        source: VEHICLE_SOURCE,
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffb020",
          "circle-stroke-color": "#0b1220",
          "circle-stroke-width": 1.5,
        },
      });

      setReady(true);
    });

    const updateBounds = () => {
      const b = instance.getBounds();
      setBbox(
        [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
          .map((n) => n.toFixed(4))
          .join(","),
      );
    };
    instance.on("moveend", updateBounds);
    instance.on("load", updateBounds);

    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;

    (instance.getSource(ROUTE_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
      routeGeoJSON(journey ?? null),
    );
    (instance.getSource(STOP_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
      stopsGeoJSON(journey ?? null),
    );

    if (journey) {
      const bounds = boundsOf(journey);
      if (bounds) {
        instance.fitBounds(bounds, {
          padding: { top: 48, bottom: 48, left: 32, right: 32 },
          maxZoom: 15,
          // Respect a reduced-motion preference rather than flying the camera.
          animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        });
      }
    }
  }, [journey, ready]);

  const vehicleUrl = useMemo(
    () => (showVehicles && bbox ? streams.vehicles({ bbox }) : null),
    [showVehicles, bbox],
  );
  const vehicles = useStream<VehiclesResponse>(vehicleUrl, "vehicles");

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const source = instance.getSource(VEHICLE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData({
      type: "FeatureCollection",
      features: (vehicles.data?.vehicles ?? []).map((v) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [v.lon, v.lat] },
        properties: { line: v.line ?? "" },
      })),
    });
  }, [vehicles.data, ready]);

  const vehicleNotice = showVehicles && vehicles.data && !vehicles.data.available
    ? vehicles.data.reason
    : null;

  return (
    <div className={className}>
      <div
        ref={container}
        className="size-full"
        role="application"
        aria-label="Karta över resan"
      />
      {styleError ? (
        <p className="absolute inset-x-3 top-3 rounded-lg bg-[var(--color-surface)]/95 p-2 text-xs text-[var(--color-muted)]">
          Kartbakgrunden kunde inte laddas. Resvägen visas ändå.
        </p>
      ) : null}
      {vehicleNotice ? (
        <p className="absolute inset-x-3 bottom-3 rounded-lg bg-[var(--color-surface)]/95 p-2 text-xs text-[var(--color-muted)]">
          {vehicleNotice}
        </p>
      ) : null}
    </div>
  );
}
