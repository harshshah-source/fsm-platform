/** A geographic point — home base, a stop's plant, or a candidate's current position mid-route. */
export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * #267/#270 — the same "no fabricated default" honesty convention `hard-filters.ts`'s `FilterState`
 * uses for filters, at distance's own per-value grain: missing SE home base, missing prior stop, or a
 * plant with no `location` all mean "cannot be computed", never a silent `0`/`(0,0)`.
 */
export const NOT_AVAILABLE = 'NOT_AVAILABLE' as const;
export type DistanceKm = number | typeof NOT_AVAILABLE;

const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance between two points, in km (#267). Deliberately simple — a chord-length
 * approximation is adequate for the recommender's SE-selection use (comparing candidates against
 * each other, not routing), and matches the issue's own "haversine" naming.
 */
export function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
