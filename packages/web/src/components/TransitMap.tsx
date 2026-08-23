import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type LngLatBoundsLike, type Map as MapLibreMap } from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";
import { Protocol } from "pmtiles";
import type { Journey, Neighbourhood, VehiclesResponse } from "@traveler/shared";
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
const RING_SOURCE = "hood-rings";
const WALK_SOURCE = "hood-walks";
const HOOD_STOP_SOURCE = "hood-stops";

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

/**
 * The isochrone rings, largest first so the smaller ones paint on top of them.
 *
 * Opacity is per feature rather than per layer: the contours are nested, and a single
 * opacity would make the middle of the neighbourhood a flat wash. Denser inward reads
 * as "closer", which is the only thing the fill is there to say.
 */
function ringsGeoJSON(hood: Neighbourhood | null): FeatureCollection {
  if (!hood) return { type: "FeatureCollection", features: [] };
  const sorted = [...hood.isochrones].sort((a, b) => b.minutes - a.minutes);
  return {
    type: "FeatureCollection",
    features: sorted.map((iso, index) => ({
      type: "Feature" as const,
      geometry: { type: "Polygon" as const, coordinates: iso.rings },
      properties: {
        minutes: iso.minutes,
        opacity: 0.05 + index * 0.05,
        // Only the widest contour is stroked; outlining every one turns the
        // neighbourhood into a contour map of itself.
        outer: index === 0,
      },
    })),
  };
}

/** The actual walk to each stop, as routed. Dashed, because it is a walk. */
function walksGeoJSON(hood: Neighbourhood | null): FeatureCollection {
  if (!hood) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: hood.stops
      .filter((stop) => stop.path.length > 1)
      .map((stop) => ({
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: stop.path },
        properties: { name: stop.name },
      })),
  };
}

function hoodStopsGeoJSON(hood: Neighbourhood | null): FeatureCollection {
  if (!hood) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: hood.stops.map((stop) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [stop.lon, stop.lat] },
      properties: { color: modeColor(stop.mode), name: stop.name },
    })),
  };
}

/** Fit to the widest contour when there is one, otherwise to the stops themselves. */
function boundsOfNeighbourhood(hood: Neighbourhood): LngLatBoundsLike | null {
  const bounds = new maplibregl.LngLatBounds([hood.lon, hood.lat], [hood.lon, hood.lat]);
  const widest = [...hood.isochrones].sort((a, b) => b.minutes - a.minutes)[0];
  if (widest) {
    for (const ring of widest.rings) for (const c of ring) bounds.extend(c);
    return bounds;
  }
  if (hood.stops.length === 0) return null;
  for (const stop of hood.stops) bounds.extend([stop.lon, stop.lat]);
  return bounds;
}

/**
 * Minutes and the place marker are DOM markers, not a symbol layer.
 *
 * A `text-field` needs glyphs, and the development basemap -- raster tiles, no
 * `glyphs` in the style -- has none, so the labels would silently not draw on exactly
 * the setup this is developed and tested on. DOM markers also inherit the theme tokens,
 * so "8 min" is legible in both themes without a second colour ramp.
 */
function minuteLabel(seconds: number): HTMLElement {
  const el = document.createElement("span");
  el.className =
    "pointer-events-none rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]/90 px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-fg)]";
  el.textContent = `${Math.max(1, Math.round(seconds / 60))} min`;
  return el;
}

function placeMarker(): HTMLElement {
  const el = document.createElement("span");
  el.className =
    "block size-4 rounded-full border-2 border-[var(--color-bg)] bg-[var(--color-accent)] shadow";
  el.setAttribute("aria-hidden", "true");
  return el;
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
  neighbourhood,
  showVehicles = false,
  className,
}: {
  journey?: Journey | null;
  /** A saved place's walking neighbourhood: rings, the walks, and the stops. */
  neighbourhood?: Neighbourhood | null;
  showVehicles?: boolean;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const hoodMarkers = useRef<maplibregl.Marker[]>([]);
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
      const message = String(e.error?.message ?? e.error ?? "");
      // A missing basemap should not take the route lines with it, but everything else
      // needs to reach the console rather than being quietly absorbed here.
      if (/style|tile|source/i.test(message)) setStyleError(true);
      else console.error("MapLibre:", message);
    });

    instance.on("load", () => {
      // The neighbourhood goes in first so the route, its stops and the vehicles all
      // draw above it: it is ground, not content.
      instance.addSource(RING_SOURCE, { type: "geojson", data: ringsGeoJSON(null) });
      instance.addSource(WALK_SOURCE, { type: "geojson", data: walksGeoJSON(null) });
      instance.addSource(HOOD_STOP_SOURCE, { type: "geojson", data: hoodStopsGeoJSON(null) });

      instance.addLayer({
        id: "hood-rings-fill",
        type: "fill",
        source: RING_SOURCE,
        paint: { "fill-color": "#4c9be8", "fill-opacity": ["get", "opacity"] },
      });
      instance.addLayer({
        id: "hood-rings-edge",
        type: "line",
        source: RING_SOURCE,
        filter: ["==", ["get", "outer"], true],
        paint: { "line-color": "#4c9be8", "line-width": 1.5, "line-opacity": 0.8 },
      });
      instance.addLayer({
        id: "hood-walk-paths",
        type: "line",
        source: WALK_SOURCE,
        paint: {
          "line-color": "#8a94a6",
          "line-width": 1.5,
          "line-dasharray": [1, 1.6],
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      instance.addLayer({
        id: "hood-stop-dots",
        type: "circle",
        source: HOOD_STOP_SOURCE,
        paint: {
          "circle-radius": 5,
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
      });

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
      // Two layers rather than one with a data-driven dash pattern: `line-dasharray`
      // does not support expressions, and a layer whose paint fails validation simply
      // does not draw. That left only the dark casing on screen -- a black line where
      // the coloured route should be, with nothing logged.
      instance.addLayer({
        id: "route-line",
        type: "line",
        source: ROUTE_SOURCE,
        filter: ["!=", ["get", "walking"], true],
        paint: { "line-color": ["get", "color"], "line-width": 4 },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      instance.addLayer({
        id: "route-walk",
        type: "line",
        source: ROUTE_SOURCE,
        filter: ["==", ["get", "walking"], true],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 3,
          "line-dasharray": [1, 1.6],
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

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const hood = neighbourhood ?? null;

    (instance.getSource(RING_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
      ringsGeoJSON(hood),
    );
    (instance.getSource(WALK_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
      walksGeoJSON(hood),
    );
    (instance.getSource(HOOD_STOP_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
      hoodStopsGeoJSON(hood),
    );

    // Markers are DOM, so they are replaced wholesale rather than diffed; a
    // neighbourhood is a few dozen stops and only changes when the place does.
    for (const marker of hoodMarkers.current) marker.remove();
    hoodMarkers.current = [];
    if (!hood) return;

    hoodMarkers.current.push(
      new maplibregl.Marker({ element: placeMarker() })
        .setLngLat([hood.lon, hood.lat])
        .addTo(instance),
    );
    for (const stop of hood.stops) {
      hoodMarkers.current.push(
        new maplibregl.Marker({ element: minuteLabel(stop.secondsTo), offset: [0, -14] })
          .setLngLat([stop.lon, stop.lat])
          .addTo(instance),
      );
    }

    const bounds = boundsOfNeighbourhood(hood);
    if (bounds) {
      instance.fitBounds(bounds, {
        padding: { top: 40, bottom: 40, left: 28, right: 28 },
        maxZoom: 15,
        animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
    }
  }, [neighbourhood, ready]);

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
        aria-label={neighbourhood ? "Karta över hållplatser i närheten" : "Karta över resan"}
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
