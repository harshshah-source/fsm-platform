import { describe, expect, it } from 'vitest';
import { normalizeZoneKey } from '../src/ingestion/autoplant/mapping-table-zone-resolver';

/**
 * Pure normalization for the R6 translation layer. Collapses AutoPlant's inconsistent raw `zone_name`
 * spellings to one dedup key so "West Zone"/"WEST"/"West" share a single crosswalk row, while junk is
 * preserved (so an admin can see and IGNORE it — the resolver never decides junk on its own).
 */
describe('normalizeZoneKey', () => {
  it('collapses the West/Zone/India spelling variants to one key', () => {
    expect(normalizeZoneKey('West Zone')).toBe('west');
    expect(normalizeZoneKey('WEST')).toBe('west');
    expect(normalizeZoneKey('West')).toBe('west');
    expect(normalizeZoneKey('  west  ')).toBe('west');
    expect(normalizeZoneKey('North India')).toBe('north');
    expect(normalizeZoneKey('North Zone India')).toBe('north');
  });

  it('collapses blank / NA / null sentinels to a single __blank__ key', () => {
    expect(normalizeZoneKey('')).toBe('__blank__');
    expect(normalizeZoneKey('   ')).toBe('__blank__');
    expect(normalizeZoneKey('NA')).toBe('__blank__');
    expect(normalizeZoneKey('null')).toBe('__blank__');
    expect(normalizeZoneKey(null)).toBe('__blank__');
    expect(normalizeZoneKey(undefined)).toBe('__blank__');
    // "zone"/"india"-only values reduce to nothing → still the blank bucket, not an empty key.
    expect(normalizeZoneKey('Zone')).toBe('__blank__');
  });

  it('preserves junk verbatim (normalized) so an admin can triage it', () => {
    expect(normalizeZoneKey('sdf')).toBe('sdf');
    expect(normalizeZoneKey('123')).toBe('123');
    expect(normalizeZoneKey('Central')).toBe('central');
  });
});
