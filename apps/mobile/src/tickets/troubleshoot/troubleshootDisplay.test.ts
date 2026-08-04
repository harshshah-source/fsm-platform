import { describe, expect, it } from '@jest/globals';
import { formatRootCauseLabel } from './troubleshootDisplay';

describe('formatRootCauseLabel', () => {
  it('title-cases a SCREAMING_SNAKE_CASE category', () => {
    expect(formatRootCauseLabel('WIRING_ISSUE')).toBe('Wiring Issue');
    expect(formatRootCauseLabel('DEVICE_HARDWARE_FAULT')).toBe('Device Hardware Fault');
  });

  it('keeps known acronyms (GPS, SIM) uppercase rather than title-casing them', () => {
    expect(formatRootCauseLabel('GPS_ANTENNA_ISSUE')).toBe('GPS Antenna Issue');
    expect(formatRootCauseLabel('SIM_NETWORK_ISSUE')).toBe('SIM Network Issue');
  });

  it('formats UNKNOWN as a single word', () => {
    expect(formatRootCauseLabel('UNKNOWN')).toBe('Unknown');
  });
});
