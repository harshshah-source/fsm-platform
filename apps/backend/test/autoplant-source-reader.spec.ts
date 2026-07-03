import {
  AutoPlantSourceReader,
  encodeCursor,
  utcIsoToSourceWallClock,
} from '../src/ingestion/autoplant/autoplant-source-reader';
import type { VehicleMasterRow } from '../src/ingestion/autoplant/mapping';

/**
 * Phase 3 — the real `SourceReader` over `tb_vehiclemaster`. Driven against a fake `query` (no MySQL):
 * we assert the keyset SQL/params, the three cursor modes (backfill / intra-run keyset / cross-run
 * watermark), device-id preservation, and exhaustion. Cursor-resume follows R10 (composite
 * `(gps_datetime, device_id)` keyset) with the persisted UTC watermark converted back to source-local.
 */

const NOW = new Date('2026-07-02T12:00:00Z');

const vm = (deviceId: string, wall: string, over: Partial<VehicleMasterRow> = {}): VehicleMasterRow => ({
  device_id: deviceId,
  latest_gps_datetime: wall,
  latitude: 12.9,
  longitude: 77.5,
  speed: 0,
  IGNITION_STATUS: null,
  DEVICE_TYPE: 'V5',
  gpssignal: { power: { mainstatus: '1', mainvoltage: '4056' } },
  ...over,
});

/** A fake query that records the last SQL/params and returns a scripted result set. */
function fakeQuery(result: VehicleMasterRow[]) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const fn = async <T>(sql: string, params: readonly unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    return result as unknown as T[];
  };
  return { fn, calls };
}

const reader = (q: ReturnType<typeof fakeQuery>, loadResumeCursor: () => Promise<string | null> = async () => null) =>
  new AutoPlantSourceReader({ query: q.fn, loadResumeCursor, now: () => NOW });

describe('Phase 3 — utcIsoToSourceWallClock', () => {
  it('shifts a UTC instant into an IST (+330) naive wall-clock string', () => {
    // 00:27:47Z + 330 min = 05:57:47 IST.
    expect(utcIsoToSourceWallClock('2026-07-02T00:27:47.000Z', 330)).toBe('2026-07-02 05:57:47');
  });
});

describe('Phase 3 — AutoPlantSourceReader', () => {
  it('backfills (cursor=null, no prior run): no keyset predicate, ordered keyset, device ids preserved', async () => {
    const q = fakeQuery([vm('0869925073271551', '2026-07-02 05:57:47'), vm('AP03TC0959', '2026-07-02 05:58:00')]);
    const chunk = await reader(q).readChunk(null, 1000);

    const sql = q.calls[0].sql;
    expect(sql).toMatch(/FROM tb_vehiclemaster/i);
    expect(sql).toMatch(/latest_gps_datetime IS NOT NULL/i);
    expect(sql).toMatch(/device_id IS NOT NULL/i);
    expect(sql).toMatch(/ORDER BY latest_gps_datetime, device_id/i);
    expect(sql).not.toMatch(/latest_gps_datetime >/); // no keyset/watermark bound on a cold backfill
    expect(chunk.rows.map((r) => r.deviceId)).toEqual(['0869925073271551', 'AP03TC0959']);
    // 05:57:47 IST → 00:27:47 UTC.
    expect(chunk.rows[0].gpsDatetime.toISOString()).toBe('2026-07-02T00:27:47.000Z');
    // Fewer than chunkSize (2 < 1000) ⇒ exhausted.
    expect(chunk.nextCursor).toBeNull();
  });

  it('returns a composite keyset nextCursor when the chunk is full', async () => {
    const q = fakeQuery([vm('D1', '2026-07-02 05:57:00'), vm('D2', '2026-07-02 05:58:00')]);
    const chunk = await reader(q).readChunk(null, 2); // full chunk (2 == chunkSize)
    expect(chunk.nextCursor).toBe(encodeCursor('2026-07-02 05:58:00', 'D2'));
  });

  it('continues intra-run from a keyset cursor with the R10 composite predicate', async () => {
    const q = fakeQuery([vm('D3', '2026-07-02 05:59:00')]);
    await reader(q).readChunk(encodeCursor('2026-07-02 05:58:00', 'D2'), 1000);

    const { sql, params } = q.calls[0];
    // (ts > ?) OR (ts = ? AND device_id > ?) — the boundary-tie-safe keyset.
    expect(sql).toMatch(/latest_gps_datetime > \?\s+OR\s+\(latest_gps_datetime = \? AND device_id > \?\)/i);
    expect(params.slice(0, 3)).toEqual(['2026-07-02 05:58:00', '2026-07-02 05:58:00', 'D2']);
  });

  it('resumes across runs from the persisted UTC watermark (>= source-local), converted from data_as_of', async () => {
    const q = fakeQuery([vm('D9', '2026-07-02 06:10:00')]);
    // Persisted snapshot_runs.cursor = last run's data_as_of (UTC ISO).
    await reader(q, async () => '2026-07-02T00:27:47.000Z').readChunk(null, 1000);

    const { sql, params } = q.calls[0];
    expect(sql).toMatch(/latest_gps_datetime >= \?/);
    expect(params[0]).toBe('2026-07-02 05:57:47'); // 00:27:47Z + 330m
  });

  it('drops a bogus future-timestamp row from the output', async () => {
    const q = fakeQuery([vm('DPRESENT', '2026-07-02 05:57:47'), vm('DFUTURE', '2027-01-01 00:00:00')]);
    const chunk = await reader(q).readChunk(null, 1000);
    expect(chunk.rows.map((r) => r.deviceId)).toEqual(['DPRESENT']);
  });

  it('signals exhaustion with a null cursor on an empty source', async () => {
    const q = fakeQuery([]);
    const chunk = await reader(q).readChunk(null, 1000);
    expect(chunk.rows).toHaveLength(0);
    expect(chunk.nextCursor).toBeNull();
  });
});
