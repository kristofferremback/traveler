const EARTH_RADIUS_M = 6_371_008.8;

export function haversineMetres(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const lat1 = aLat * toRad;
  const lat2 = bLat * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type BBox = { minLon: number; minLat: number; maxLon: number; maxLat: number };

export function bboxFromTuple(t: number[]): BBox {
  const [minLon, minLat, maxLon, maxLat] = t as [number, number, number, number];
  return { minLon, minLat, maxLon, maxLat };
}

export function withinBBox(lat: number, lon: number, b: BBox): boolean {
  return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
}

/**
 * Latitude/longitude deltas covering `metres` at this latitude. Used to turn a radius
 * query into an indexable BETWEEN before the exact haversine pass -- SQLite has no
 * spatial index here and a full scan of 6.5k sites per keystroke is wasteful.
 */
export function degreeBox(lat: number, lon: number, metres: number): BBox {
  const dLat = (metres / EARTH_RADIUS_M) * (180 / Math.PI);
  const cos = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const dLon = dLat / cos;
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLon: lon - dLon,
    maxLon: lon + dLon,
  };
}
