import {
  STATE_ZONE_MAP,
  stateToZone,
  normalizeSourceZoneName,
  deriveZone,
} from '../src/ingestion/autoplant/state-zone-map';

/**
 * Phase 4 / R6 — PROVISIONAL `plant_state → FSM zone` derivation (pending Ops-Head ratification;
 * docs/autoplant/R6-zone-map-proposal.md). Pure + unit-testable. Junk states → null (UNZONED / defer);
 * AutoPlant's own `zone_name` is a cross-check that flags conflicts, never an override.
 */
describe('R6 — stateToZone (provisional map)', () => {
  it('maps the states confirmed present in the plant data', () => {
    expect(stateToZone('Andhra Pradesh')).toBe('SOUTH');
    expect(stateToZone('Karnataka')).toBe('SOUTH');
    expect(stateToZone('Tamil Nadu')).toBe('SOUTH');
    expect(stateToZone('Maharashtra')).toBe('WEST');
    expect(stateToZone('Madhya Pradesh')).toBe('WEST');
    expect(stateToZone('Uttar Pradesh')).toBe('NORTH');
    expect(stateToZone('Delhi')).toBe('NORTH');
    expect(stateToZone('West Bengal')).toBe('EAST');
    expect(stateToZone('Odisha')).toBe('EAST');
    expect(stateToZone('Jharkhand')).toBe('EAST');
    expect(stateToZone('Bihar')).toBe('EAST');
    expect(stateToZone('Assam')).toBe('EAST');
  });

  it('follows AutoPlant and places Chhattisgarh in EAST (flagged ambiguity)', () => {
    expect(stateToZone('Chhattisgarh')).toBe('EAST');
  });

  it('is case/whitespace-insensitive', () => {
    expect(stateToZone('  karnataka ')).toBe('SOUTH');
    expect(stateToZone('JAMMU & KASHMIR')).toBe('NORTH');
  });

  it('returns null (UNZONED) for junk / unmapped states', () => {
    expect(stateToZone('india')).toBeNull();
    expect(stateToZone('NA')).toBeNull();
    expect(stateToZone('')).toBeNull();
    expect(stateToZone(null)).toBeNull();
    expect(stateToZone('Atlantis')).toBeNull();
  });

  it('every mapped value is one of the four FSM zones', () => {
    const zones = new Set(Object.values(STATE_ZONE_MAP));
    expect([...zones].sort()).toEqual(['EAST', 'NORTH', 'SOUTH', 'WEST']);
  });
});

describe('R6 — normalizeSourceZoneName (AutoPlant zone_name cross-check)', () => {
  it('normalizes AutoPlant’s inconsistent directional labels', () => {
    expect(normalizeSourceZoneName('North')).toBe('NORTH');
    expect(normalizeSourceZoneName('North India')).toBe('NORTH');
    expect(normalizeSourceZoneName('West Zone')).toBe('WEST');
    expect(normalizeSourceZoneName('South India')).toBe('SOUTH');
    expect(normalizeSourceZoneName('East')).toBe('EAST');
    expect(normalizeSourceZoneName('')).toBeNull();
    expect(normalizeSourceZoneName('Noth India')).toBeNull(); // typo in real data → no false match
  });
});

describe('R6 — deriveZone (state wins; source zone_name only flags conflicts)', () => {
  it('derives the zone from state and reports no conflict when source agrees', () => {
    expect(deriveZone('Maharashtra', 'West Zone')).toEqual({ zoneName: 'WEST', conflict: false });
    expect(deriveZone('Andhra Pradesh', 'South India')).toEqual({ zoneName: 'SOUTH', conflict: false });
  });

  it('flags a conflict when AutoPlant’s zone_name disagrees with the state-derived zone', () => {
    // Chhattisgarh → EAST (our map) but a plant tagged "West" by AutoPlant → conflict for the queue.
    expect(deriveZone('Chhattisgarh', 'West')).toEqual({ zoneName: 'EAST', conflict: true });
  });

  it('never conflicts when either side is absent/unmapped', () => {
    expect(deriveZone('Maharashtra', null)).toEqual({ zoneName: 'WEST', conflict: false });
    expect(deriveZone('india', 'North')).toEqual({ zoneName: null, conflict: false });
  });
});
