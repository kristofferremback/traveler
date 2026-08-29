import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import maplibregl, { type LngLatBoundsLike, type Map as MapLibreMap } from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";
import { Protocol } from "pmtiles";
import type {
  CommuteOption,
  Journey,
  Neighbourhood,
  VehiclesResponse,
} from "@traveler/shared";
import { streams } from "@/lib/api";
import { useStream } from "@/hooks/useStream";
import { modeColor } from "@/lib/modes";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
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
const OUR_WALK_SOURCE = "our-walk";

type Theme = "dark" | "light";

/**
 * The basemap follows the system theme, and so does the style the server hands out.
 *
 * `VITE_MAP_STYLE`, when set, overrides the whole URL; the theme rides along anyway so a
 * self-hosted style that understands it can answer in kind, and one that does not simply
 * ignores an unknown query parameter.
 */
function styleUrl(theme: Theme): string {
  const base = import.meta.env.VITE_MAP_STYLE || "/api/map/style.json";
  return `${base}${base.includes("?") ? "&" : "?"}theme=${theme}`;
}

/**
 * What the map falls back to when the basemap style cannot be fetched at all.
 *
 * Without a style MapLibre never fires `load`, our sources are never added, and the
 * route is not drawn either: "the basemap failed" would silently mean "the map failed".
 * A blank style with one background layer loads instantly and cannot itself fail, so
 * the route, the markers and the notice all appear on a plain ground instead.
 */
function blankStyle(theme: Theme): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": theme === "light" ? "#e5e7eb" : "#0f172a" },
      },
    ],
  };
}

function systemTheme(): Theme {
  return typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

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
 * Our own walk at the enumerated end, as routed by Valhalla.
 *
 * The stored path always runs place → stop, so the destination side is reversed: the
 * traveller walks it the other way, and a line that starts at the stop is the one the
 * arrow of the trip actually follows.
 */
function ourWalkGeoJSON(option: CommuteOption | null): FeatureCollection {
  const features: Feature[] = [];
  if (option) {
    const originPath = option.origin.stop?.path ?? [];
    if (originPath.length > 1) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: originPath },
        properties: {},
      });
    }
    const destinationPath = option.destination.stop?.path ?? [];
    if (destinationPath.length > 1) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [...destinationPath].reverse() },
        properties: {},
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
        opacity: 0.10 + index * 0.06,
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
 * A `text-field` needs glyphs the self-hosted pmtiles style does not ship, so the labels
 * would silently not draw on exactly the setup someone chose for privacy. DOM markers
 * also inherit the theme tokens, so "8 min" is legible in both themes without a second
 * colour ramp.
 */
function minuteLabel(seconds: number): HTMLElement {
  const el = document.createElement("span");
  el.className =
    "pointer-events-none rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]/90 px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-fg)]";
  el.textContent = `${Math.max(1, Math.round(seconds / 60))} min`;
  return el;
}

/** Where the trip starts: a dot with a halo, so it reads as "here" and not as a stop. */
function placeMarker(): HTMLElement {
  const el = document.createElement("span");
  el.className =
    "block size-5 rounded-full border-[3px] border-white bg-[var(--color-accent)] shadow-[0_0_0_7px_color-mix(in_oklch,var(--color-accent)_28%,transparent),0_2px_6px_rgba(0,0,0,0.4)]";
  el.setAttribute("aria-hidden", "true");
  return el;
}

/**
 * What happens at a stop, said on the map where it happens.
 *
 * The boarding stop gets the line, the departure time and the name; a change gets the
 * next line and its time; the alighting stop gets the arrival. The boarding callout is
 * the emphasised one because it is the next thing the traveller does. DOM markers for
 * the same reason as the minute labels: no glyphs to depend on, theme tokens for free.
 */
type Callout = {
  at: [number, number];
  time: string | null;
  name: string | null;
  line: { color: string; designation: string } | null;
  primary: boolean;
};

function calloutsOf(journey: Journey | null): Callout[] {
  if (!journey) return [];
  const rides = journey.legs.filter((leg) => leg.mode !== "WALK");
  const out: Callout[] = [];
  rides.forEach((leg, i) => {
    const { lat, lon } = leg.origin;
    if (lat === null || lon === null) return;
    out.push({
      at: [lon, lat],
      time: leg.origin.expected ?? leg.origin.scheduled,
      name: i === 0 ? leg.origin.name : null,
      line: { color: modeColor(leg.mode, leg.line?.designation), designation: leg.line?.designation ?? "" },
      primary: i === 0,
    });
  });
  const last = rides.at(-1);
  if (last && last.destination.lat !== null && last.destination.lon !== null) {
    out.push({
      at: [last.destination.lon, last.destination.lat],
      time: last.destination.expected ?? last.destination.scheduled,
      name: last.destination.name,
      line: null,
      primary: false,
    });
  }
  return out;
}

function calloutElement(c: Callout): HTMLElement {
  const el = document.createElement("span");
  el.className = cn(
    "pointer-events-none flex items-center gap-1.5 whitespace-nowrap rounded-xl border px-2 py-1 text-[13px] shadow-md",
    c.primary
      ? "border-transparent bg-[var(--color-fg)] text-[var(--color-bg)]"
      : "border-[var(--color-border)] bg-[var(--color-surface)]/95 text-[var(--color-fg)] backdrop-blur",
  );
  if (c.line) {
    const badge = document.createElement("span");
    badge.className = "rounded-md px-1.5 py-0.5 text-xs font-bold text-white";
    badge.style.backgroundColor = c.line.color;
    badge.textContent = c.line.designation;
    el.appendChild(badge);
  }
  if (c.time) {
    const time = document.createElement("span");
    time.className = "font-semibold tabular-nums";
    time.textContent = formatTime(c.time);
    el.appendChild(time);
  }
  if (c.name) {
    const name = document.createElement("span");
    name.className = c.primary ? "opacity-75" : "text-[var(--color-muted)]";
    name.textContent = c.name;
    el.appendChild(name);
  }
  return el;
}

/** What names the departure whose vehicle the map should show. */
export type VehicleTrip = {
  /** The planner's trip id for the leg; the server reads the line gid off it. */
  tripId: string;
  line: string;
  /** Scheduled departure at the boarding stop, ISO. */
  boardAt: string;
  lat: number;
  lon: number;
};

/**
 * A vehicle on the trip's line: the number in the line's colour, pointing its way. The
 * traveller's own vehicle, once the server knows which it is, is the larger one.
 */
function vehiclePill(line: string, color: string, bearing: number | null, exact: boolean): HTMLElement {
  const el = document.createElement("span");
  el.className = cn(
    "vehicle pointer-events-none flex items-center gap-0.5 rounded-full border-2 border-[var(--color-bg)] font-bold text-white shadow",
    exact ? "vehicle-exact px-2.5 py-1 text-[14px] shadow-lg" : "px-1.5 py-0.5 text-[11px]",
  );
  el.style.backgroundColor = color;
  el.textContent = line;
  if (bearing !== null) {
    const arrow = document.createElement("span");
    arrow.textContent = "➤";
    arrow.className = "inline-block text-[9px]";
    arrow.style.transform = `rotate(${Math.round(bearing - 90)}deg)`;
    el.appendChild(arrow);
  }
  return el;
}

/** Where the trip ends: a ring rather than a dot, so the two ends never read alike. */
function destinationMarker(): HTMLElement {
  const el = document.createElement("span");
  el.className =
    "block size-4 rounded-full border-[3px] border-[var(--color-fg)] bg-[var(--color-bg)] shadow";
  el.setAttribute("aria-hidden", "true");
  return el;
}

/**
 * How coarsely a box is asked for: about a kilometre at this latitude.
 *
 * The box is part of the vehicle stream's URL and the stream reopens whenever that URL
 * changes, so an exact viewport dropped the feed and opened a new connection on every
 * pan, pinch and automatic camera fit. Snapped outward to this grid, the string holds
 * still across small movements and still covers everything on screen.
 */
const BOX_GRID = 0.01;

function boxParam(bounds: maplibregl.LngLatBounds): string {
  const down = (n: number) => Math.floor(n / BOX_GRID) * BOX_GRID;
  const up = (n: number) => Math.ceil(n / BOX_GRID) * BOX_GRID;
  return [down(bounds.getWest()), down(bounds.getSouth()), up(bounds.getEast()), up(bounds.getNorth())]
    .map((n) => n.toFixed(2))
    .join(",");
}

function boundsOf(journey: Journey): maplibregl.LngLatBounds | null {
  const coords = journey.legs.flatMap((leg) => leg.path);
  if (coords.length === 0) return null;
  const bounds = new maplibregl.LngLatBounds(coords[0], coords[0]);
  for (const c of coords) bounds.extend(c);
  return bounds;
}

/** The ride, our walks and both doors: everything the traveller is being shown. */
function boundsOfOption(option: CommuteOption): maplibregl.LngLatBounds | null {
  const coords: [number, number][] = [
    ...option.journey.legs.flatMap((leg) => leg.path),
    ...(option.origin.stop?.path ?? []),
    ...(option.destination.stop?.path ?? []),
  ];
  if (coords.length === 0) return null;
  const bounds = new maplibregl.LngLatBounds(coords[0]!, coords[0]!);
  for (const c of coords) bounds.extend(c);
  return bounds;
}

/** The two doors, when the paths are known. */
function doorsOf(option: CommuteOption | null): {
  start: [number, number] | null;
  end: [number, number] | null;
} {
  if (!option) return { start: null, end: null };
  const originPath = option.origin.stop?.path ?? [];
  const destinationPath = option.destination.stop?.path ?? [];
  return {
    start: originPath[0] ?? null,
    // Our stored path runs place → stop on both ends, so the far door is its start.
    end: destinationPath[0] ?? null,
  };
}

export function TransitMap({
  journey,
  option,
  neighbourhood,
  showVehicles = false,
  vehicleTrip = null,
  bottomInset = 0,
  className,
}: {
  journey?: Journey | null;
  /** A door-to-door option: the ride, plus our own walk at either end. */
  option?: CommuteOption | null;
  /** A saved place's walking neighbourhood: rings, the walks, and the stops. */
  neighbourhood?: Neighbourhood | null;
  showVehicles?: boolean;
  /**
   * The departure whose vehicle to draw: the selected trip's first ride, so the
   * traveller can see their 443 coming. The server answers with that one vehicle when
   * it can tell which it is, and with every vehicle on the line otherwise; the pill
   * says which by its size. Nothing is drawn when the feed is unavailable; the map does
   * not need a notice for that.
   */
  vehicleTrip?: VehicleTrip | null;
  /** Pixels at the bottom covered by something else, such as the commute sheet. */
  bottomInset?: number;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const hoodMarkers = useRef<maplibregl.Marker[]>([]);
  const doorMarkers = useRef<maplibregl.Marker[]>([]);
  const calloutMarkers = useRef<maplibregl.Marker[]>([]);
  const vehicleMarkers = useRef<maplibregl.Marker[]>([]);
  const [ready, setReady] = useState(false);
  const [bbox, setBbox] = useState<string | null>(null);
  const [styleError, setStyleError] = useState(false);
  const [theme, setTheme] = useState<Theme>(systemTheme);
  const appliedTheme = useRef<Theme>(systemTheme());

  /** The journey drawn is either the plain one or the option's ride. */
  const drawn = option?.journey ?? journey ?? null;

  /**
   * Read at fit time, not depended on.
   *
   * The sheet reports a new inset on every pixel of a drag, and a camera that refits on
   * each of them fights the hand doing the dragging. The next fit -- another option, a
   * refresh -- uses wherever the sheet ended up.
   *
   * Capped here rather than by the caller: a fit whose padding is taller than the
   * container has nowhere to put the route. The uncapped figure is still what the
   * attribution is placed against, because that has to clear the sheet at every height.
   */
  const insetRef = useRef(0);
  insetRef.current = Math.min(bottomInset, Math.round(window.innerHeight * 0.4));

  useEffect(() => {
    if (!container.current || map.current) return;
    registerProtocol();

    const instance = new maplibregl.Map({
      container: container.current,
      style: styleUrl(systemTheme()),
      center: STOCKHOLM_CENTRE,
      zoom: 11,
      // Flat, and it stays flat. Vehicle markers and route lines are the content;
      // tilting only makes them harder to read on a phone.
      pitch: 0,
      attributionControl: { compact: true },
      pitchWithRotate: false,
      dragRotate: false,
      touchPitch: false,
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
      if (/style|tile|source/i.test(message)) {
        setStyleError(true);
        // The style itself failed to arrive (first load or a theme swap): give the map
        // a style that cannot fail so `load`/`style.load` fire and the route is drawn.
        if (/style/i.test(message) && !instance.isStyleLoaded()) {
          instance.setStyle(blankStyle(appliedTheme.current));
        }
      } else console.error("MapLibre:", message);
    });

    instance.on("load", () => {
      addSourcesAndLayers(instance);
      setReady(true);
    });

    const updateBounds = () => setBbox(boxParam(instance.getBounds()));
    instance.on("moveend", updateBounds);
    instance.on("load", updateBounds);

    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  // The system theme can change while the app is open -- at sunset, on a schedule, by
  // hand -- and a dark app on a white map is unusable outdoors, which is when it flips.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setTheme(media.matches ? "light" : "dark");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  /**
   * Swapping the style throws away every source and layer with it, ours included.
   *
   * They are added back on `style.load`, and `ready` goes false and true around it so
   * every effect below re-runs and pushes its data into the fresh sources. Without that
   * the map keeps its new colours and loses the route.
   */
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    if (theme === appliedTheme.current) return;
    appliedTheme.current = theme;

    setReady(false);
    instance.setStyle(styleUrl(theme));
    instance.once("style.load", () => {
      addSourcesAndLayers(instance);
      setReady(true);
    });
  }, [theme, ready]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;

    (instance.getSource(ROUTE_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
      routeGeoJSON(drawn),
    );
    (instance.getSource(STOP_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
      stopsGeoJSON(drawn),
    );
    (instance.getSource(OUR_WALK_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
      ourWalkGeoJSON(option ?? null),
    );

    for (const marker of doorMarkers.current) marker.remove();
    doorMarkers.current = [];
    const doors = doorsOf(option ?? null);
    if (doors.start) {
      doorMarkers.current.push(
        new maplibregl.Marker({ element: placeMarker() }).setLngLat(doors.start).addTo(instance),
      );
    }
    if (doors.end) {
      doorMarkers.current.push(
        new maplibregl.Marker({ element: destinationMarker() })
          .setLngLat(doors.end)
          .addTo(instance),
      );
    }

    /**
     * Callouts lean away from the edge they are near: one at the right of the screen
     * hangs to the left of its stop, so the name is on screen rather than clipped. A
     * marker's anchor is fixed at creation, so they are rebuilt after every move.
     */
    const callouts = calloutsOf(drawn);
    const render = () => {
      for (const marker of calloutMarkers.current) marker.remove();
      calloutMarkers.current = [];
      const width = instance.getContainer().clientWidth;
      for (const c of callouts) {
        const x = instance.project(c.at).x;
        const anchor = x > width * 0.62 ? "bottom-right" : x < width * 0.38 ? "bottom-left" : "bottom";
        calloutMarkers.current.push(
          new maplibregl.Marker({ element: calloutElement(c), anchor, offset: [0, -10] })
            .setLngLat(c.at)
            .addTo(instance),
        );
      }
    };
    render();
    instance.on("moveend", render);

    const bounds = option ? boundsOfOption(option) : drawn ? boundsOf(drawn) : null;
    if (bounds) {
      instance.fitBounds(bounds, {
        // The sheet covers the bottom of the map, so the padding has to keep the trip
        // above it rather than centring it under the rows; the sides leave room for a
        // callout to hang off its stop.
        padding: { top: 120, bottom: 48 + insetRef.current, left: 40, right: 40 },
        maxZoom: 15,
        // Respect a reduced-motion preference rather than flying the camera.
        animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
    }
    return () => {
      instance.off("moveend", render);
    };
  }, [drawn, option, ready]);

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

    /**
     * Place the markers, skipping a label that would land on one already placed.
     *
     * A symbol layer would do this collision test itself, but it needs glyphs the
     * self-hosted basemap does not ship. Nearest-first, so the label that survives a
     * cluster is the stop the walk is shortest to -- and it is redone on every camera
     * move, because what collides depends on the zoom.
     */
    const render = () => {
      for (const marker of hoodMarkers.current) marker.remove();
      hoodMarkers.current = [];
      if (!hood) return;

      hoodMarkers.current.push(
        new maplibregl.Marker({ element: placeMarker() })
          .setLngLat([hood.lon, hood.lat])
          .addTo(instance),
      );

      const placed: { x: number; y: number }[] = [];
      for (const stop of [...hood.stops].sort((a, b) => a.secondsTo - b.secondsTo)) {
        const at = instance.project([stop.lon, stop.lat]);
        if (placed.some((p) => Math.abs(p.x - at.x) < 46 && Math.abs(p.y - at.y) < 20)) continue;
        placed.push(at);
        hoodMarkers.current.push(
          new maplibregl.Marker({ element: minuteLabel(stop.secondsTo), offset: [0, -14] })
            .setLngLat([stop.lon, stop.lat])
            .addTo(instance),
        );
      }
    };

    render();
    instance.on("moveend", render);
    const detach = () => {
      instance.off("moveend", render);
    };
    if (!hood) return detach;

    const bounds = boundsOfNeighbourhood(hood);
    if (bounds) {
      instance.fitBounds(bounds, {
        padding: { top: 40, bottom: 40 + insetRef.current, left: 28, right: 28 },
        maxZoom: 15,
        animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
    }

    return detach;
  }, [neighbourhood, ready]);

  const wantsVehicles = showVehicles || vehicleTrip !== null;

  /**
   * The box the vehicle feed is asked for.
   *
   * Following one departure it is the trip's own, not the viewport's: the bus can be
   * behind you and off the top of the screen, and which bus it is has nothing to do with
   * where the camera points. Tying it to the camera also tied the connection to the
   * camera, and since fitting the map to a tapped trip is a camera move, browsing the
   * list dropped and reopened the feed once per row.
   */
  const vehicleBox = useMemo(() => {
    if (!vehicleTrip) return bbox;
    const bounds = option ? boundsOfOption(option) : null;
    // Before the geometry has arrived, a box around the stop being boarded at, wide
    // enough to hold a vehicle that has not reached it yet.
    return boxParam(
      bounds ??
        new maplibregl.LngLatBounds(
          [vehicleTrip.lon - 0.12, vehicleTrip.lat - 0.06],
          [vehicleTrip.lon + 0.12, vehicleTrip.lat + 0.06],
        ),
    );
  }, [vehicleTrip, option, bbox]);

  const vehicleUrl = useMemo(
    () =>
      wantsVehicles && vehicleBox
        ? streams.vehicles({
            bbox: vehicleBox,
            ...(vehicleTrip
              ? {
                  line: vehicleTrip.line,
                  trip: vehicleTrip.tripId,
                  boardAt: vehicleTrip.boardAt,
                  boardLat: vehicleTrip.lat,
                  boardLon: vehicleTrip.lon,
                }
              : {}),
          })
        : null,
    [wantsVehicles, vehicleBox, vehicleTrip],
  );
  const vehicles = useStream<VehiclesResponse>(vehicleUrl, "vehicles");

  // The departure's vehicle, as a pill with the line number, so "the 443 is two stops
  // away" is something the map says. The server already narrowed the feed to the one
  // vehicle or to the line; the pill's size tells the two apart.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    for (const marker of vehicleMarkers.current) marker.remove();
    vehicleMarkers.current = [];
    if (!vehicleTrip) return;
    const exact = vehicles.data?.match === "trip";
    for (const v of vehicles.data?.vehicles ?? []) {
      // The server narrows the feed to the departure or its line; this is the belt to
      // that brace, so a feed that widens can never flood the map again.
      if (!v.line || (!exact && v.line !== vehicleTrip.line)) continue;
      vehicleMarkers.current.push(
        new maplibregl.Marker({ element: vehiclePill(v.line, modeColor(v.mode, v.line), v.bearing, exact) })
          .setLngLat([v.lon, v.lat])
          .addTo(instance),
      );
    }
  }, [vehicles.data, vehicleTrip, ready]);

  // Every vehicle in view, as dots: only for a screen that asked for all of them. The
  // commute map opens the same stream for its trip's lines and must not get the lot.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const source = instance.getSource(VEHICLE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData({
      type: "FeatureCollection",
      features: (showVehicles ? (vehicles.data?.vehicles ?? []) : []).map((v) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [v.lon, v.lat] },
        properties: { line: v.line ?? "" },
      })),
    });
  }, [vehicles.data, showVehicles, ready]);

  const vehicleNotice = showVehicles && vehicles.data && !vehicles.data.available
    ? vehicles.data.reason
    : null;

  return (
    // The sheet's height, published to CSS: MapLibre's own controls are positioned
    // against it so they sit just clear of whatever is covering the bottom of the map.
    <div className={className} style={{ "--map-inset": `${bottomInset}px` } as CSSProperties}>
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

/**
 * Every source and layer this component owns, in paint order.
 *
 * Called on first load and again after every `setStyle`, because a style swap drops all
 * of them. It has to be idempotent for a map that reloads its style twice in a row.
 */
function addSourcesAndLayers(instance: MapLibreMap) {
  if (instance.getSource(RING_SOURCE)) return;

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
    paint: { "line-color": "#4c9be8", "line-width": 2, "line-opacity": 0.9 },
  });
  instance.addLayer({
    id: "hood-walk-paths",
    type: "line",
    source: WALK_SOURCE,
    paint: {
      "line-color": "#1f2937",
      "line-width": 2,
      "line-opacity": 0.7,
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
  instance.addSource(OUR_WALK_SOURCE, { type: "geojson", data: ourWalkGeoJSON(null) });
  instance.addSource(VEHICLE_SOURCE, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  // A wide, blurred copy of the line under everything else. It is what makes the
  // option being shown look chosen rather than merely present, at a glance, from
  // arm's length, without changing the line's own colour.
  instance.addLayer({
    id: "route-glow",
    type: "line",
    source: ROUTE_SOURCE,
    filter: ["!=", ["get", "walking"], true],
    paint: {
      "line-color": ["get", "color"],
      "line-width": 12,
      "line-blur": 6,
      "line-opacity": 0.45,
    },
    layout: { "line-cap": "round", "line-join": "round" },
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
  // Our own walk, dashed like SL's but in the accent colour: this is the half of the
  // trip the app worked out, and it is the half the traveller is being asked to trust.
  instance.addLayer({
    id: "our-walk-line",
    type: "line",
    source: OUR_WALK_SOURCE,
    paint: {
      "line-color": "#4c9be8",
      "line-width": 3,
      "line-dasharray": [1, 1.4],
      "line-opacity": 0.95,
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
}
