import { describe, expect, it } from 'vitest';
import { formatPlantDisplayName, plantCodePrefix, PLANT_FULL_NAME } from '../src/lib/plantNames';

describe('formatPlantDisplayName', () => {
  it('maps a known prefix and keeps the original code in parentheses', () => {
    expect(formatPlantDisplayName('ACP-9106')).toBe('ARASMETA CEMENT PLANT (ACP-9106)');
    expect(formatPlantDisplayName('JCP-9234')).toBe('JOJOBERA CEMENT PLANT (JCP-9234)');
    expect(formatPlantDisplayName('RCP-9211')).toBe('RISDA CEMENT PLANT (RCP-9211)');
  });

  it('splits on underscore as well as hyphen', () => {
    expect(formatPlantDisplayName('RCP_NVL_HUB')).toBe('RISDA CEMENT PLANT (RCP_NVL_HUB)');
  });

  it('is case-insensitive on the prefix but preserves the raw code verbatim', () => {
    expect(formatPlantDisplayName('acp-9106')).toBe('ARASMETA CEMENT PLANT (acp-9106)');
  });

  it('returns an unmapped identifier unchanged', () => {
    expect(formatPlantDisplayName('Yard-1')).toBe('Yard-1');
    expect(formatPlantDisplayName('Mumbai Yard')).toBe('Mumbai Yard');
    expect(formatPlantDisplayName('ZZZ-0001')).toBe('ZZZ-0001');
  });

  it('never throws and never returns null on nullish/blank input', () => {
    expect(formatPlantDisplayName(null)).toBe('');
    expect(formatPlantDisplayName(undefined)).toBe('');
    expect(formatPlantDisplayName('')).toBe('');
    expect(formatPlantDisplayName('   ')).toBe('');
  });

  it('every mapped prefix round-trips', () => {
    for (const prefix of Object.keys(PLANT_FULL_NAME)) {
      expect(formatPlantDisplayName(`${prefix}-1234`)).toBe(`${PLANT_FULL_NAME[prefix]} (${prefix}-1234)`);
    }
  });

  it('plantCodePrefix extracts the leading segment', () => {
    expect(plantCodePrefix('ACP-9106')).toBe('ACP');
    expect(plantCodePrefix('rcp_nvl_hub')).toBe('RCP');
  });
});
