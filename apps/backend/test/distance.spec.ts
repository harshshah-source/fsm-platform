import { haversineKm } from '../src/recommender/distance';

/**
 * #267 AC — haversine unit-tested against known city pairs (±1%). Expected values are the published
 * great-circle distances between these coordinate pairs (London–Paris ≈344 km, Delhi–Mumbai ≈1150 km),
 * not derived from this file's own implementation.
 */
describe('#267 — haversineKm', () => {
  it('London to Paris ≈ 344 km', () => {
    const london = { lat: 51.5074, lng: -0.1278 };
    const paris = { lat: 48.8566, lng: 2.3522 };
    const km = haversineKm(london, paris);
    expect(km).toBeGreaterThan(344 * 0.99);
    expect(km).toBeLessThan(344 * 1.01);
  });

  it('Delhi to Mumbai ≈ 1150 km', () => {
    const delhi = { lat: 28.6139, lng: 77.209 };
    const mumbai = { lat: 19.076, lng: 72.8777 };
    const km = haversineKm(delhi, mumbai);
    expect(km).toBeGreaterThan(1150 * 0.99);
    expect(km).toBeLessThan(1150 * 1.01);
  });

  it('a point to itself is 0', () => {
    const p = { lat: 12.34, lng: 56.78 };
    expect(haversineKm(p, p)).toBeCloseTo(0, 6);
  });
});
