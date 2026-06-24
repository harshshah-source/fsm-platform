import {
  normalizeGpsTimestamp,
  normalizeSourceRow,
  type RawSourceRow,
} from '../src/ingestion/normalize';

/**
 * Issue 04, slice 6 — source timestamps normalized to UTC at ingestion (AC#3).
 *
 * AutoPlant returns GPS datetimes as naive wall-clock values in a source timezone (IST by default).
 * Ingestion converts them to the correct UTC instant before they hit `raw_device_snapshots`
 * (timestamptz, UTC by convention). All other telemetry is preserved verbatim — normalization only
 * touches the timestamp.
 */
describe('Issue 04 slice 6 — UTC normalization', () => {
  it('converts an IST (+05:30) wall-clock to the correct UTC instant', () => {
    const utc = normalizeGpsTimestamp('2026-06-19 13:30:00', 330);
    expect(utc.toISOString()).toBe('2026-06-19T08:00:00.000Z');
  });

  it('leaves a UTC (+00:00) wall-clock unchanged', () => {
    const utc = normalizeGpsTimestamp('2026-06-19 08:00:00', 0);
    expect(utc.toISOString()).toBe('2026-06-19T08:00:00.000Z');
  });

  it('converts a negative-offset (-05:00) wall-clock to UTC', () => {
    const utc = normalizeGpsTimestamp('2026-06-19 03:00:00', -300);
    expect(utc.toISOString()).toBe('2026-06-19T08:00:00.000Z');
  });

  it('accepts the ISO "T" separator', () => {
    const utc = normalizeGpsTimestamp('2026-06-19T13:30:00', 330);
    expect(utc.toISOString()).toBe('2026-06-19T08:00:00.000Z');
  });

  it('throws on an unparseable timestamp', () => {
    expect(() => normalizeGpsTimestamp('not-a-date', 330)).toThrow();
  });

  it('normalizes the timestamp while preserving telemetry verbatim', () => {
    const raw: RawSourceRow = {
      deviceId: 9_200_001n,
      gpsWallClock: '2026-06-19 13:30:00',
      sourceUtcOffsetMinutes: 330,
      lat: 12.971599,
      lon: 77.594566,
      mainsStatus: 1,
      mainsVoltage: 12.4,
      ignitionStatus: 'ON',
      csq: 21,
      deviceType: 'GT06',
    };

    const row = normalizeSourceRow(raw);

    expect(row.gpsDatetime.toISOString()).toBe('2026-06-19T08:00:00.000Z');
    expect(row.deviceId).toBe(9_200_001n);
    expect(row.lat).toBe(12.971599);
    expect(row.lon).toBe(77.594566);
    expect(row.mainsStatus).toBe(1);
    expect(row.mainsVoltage).toBe(12.4);
    expect(row.ignitionStatus).toBe('ON');
    expect(row.csq).toBe(21);
    expect(row.deviceType).toBe('GT06');
    // the source-only normalization inputs must not leak into the row
    expect('gpsWallClock' in row).toBe(false);
    expect('sourceUtcOffsetMinutes' in row).toBe(false);
  });
});
