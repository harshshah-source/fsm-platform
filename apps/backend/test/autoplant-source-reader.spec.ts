import {
  AutoPlantSourceReader,
  encodeDeviceCursor,
} from '../src/ingestion/autoplant/autoplant-source-reader';
import type { VehicleMasterRow } from '../src/ingestion/autoplant/mapping';

/**
 * Phase 3 — the real `SourceReader` over `tb_vehiclemaster`, driven against a fake `query` (no MySQL).
 *
 * ONE deterministic scan engine (no cold/incremental split): page by the immutable `device_id`,
 * `ORDER BY device_id`, keyset `device_id > ?`, and NO `latest_gps_datetime` predicate. This is the
 * only correct shape against a latest-state table the live fleet mutates forward — scan progress rides
 * the immutable key, so a device that re-pings (or backdates) mid-scan can never sort back ahead of the
 * cursor and be re-read, and no telemetry watermark participates in *which* rows are visited. Every
 * device is visited exactly once per run; `data_as_of` is informational only.
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

const reader = (q: ReturnType<typeof fakeQuery>) =>
  new AutoPlantSourceReader({ query: q.fn, now: () => NOW });

describe('Phase 3 — AutoPlantSourceReader (single device-scan engine)', () => {
  it('first page (cursor=null): pages by device_id, no continuation bound, no telemetry watermark', async () => {
    const q = fakeQuery([vm('0869925073271551', '2026-07-02 05:57:47'), vm('AP03TC0959', '2026-07-02 05:58:00')]);
    const chunk = await reader(q).readChunk(null, 1000);

    const { sql, params } = q.calls[0];
    expect(sql).toMatch(/FROM tb_vehiclemaster/i);
    expect(sql).toMatch(/latest_gps_datetime IS NOT NULL/i);
    expect(sql).toMatch(/device_id IS NOT NULL/i);
    expect(sql).toMatch(/ORDER BY device_id/i);
    expect(sql).not.toMatch(/ORDER BY latest_gps_datetime/i); // never the mutating column
    expect(sql).not.toMatch(/device_id > /); // first page carries no continuation bound
    // device-id preserved verbatim (leading-zero IMEI + alphanumeric vendor id).
    expect(chunk.rows.map((r) => r.deviceId)).toEqual(['0869925073271551', 'AP03TC0959']);
    // 05:57:47 IST → 00:27:47 UTC.
    expect(chunk.rows[0].gpsDatetime.toISOString()).toBe('2026-07-02T00:27:47.000Z');
    expect(params).toEqual([]);
    // Fewer than chunkSize (2 < 1000) ⇒ exhausted.
    expect(chunk.nextCursor).toBeNull();
  });

  it('emits a device-keyset nextCursor (the last device_id) when the chunk is full', async () => {
    const q = fakeQuery([vm('D1', '2026-07-02 05:57:00'), vm('D2', '2026-07-02 05:58:00')]);
    const chunk = await reader(q).readChunk(null, 2); // full chunk (2 == chunkSize)
    expect(chunk.nextCursor).toBe(encodeDeviceCursor('D2'));
  });

  it('continues from a device cursor with a device_id > ? bound, ordered by device_id', async () => {
    const q = fakeQuery([vm('D3', '2026-07-02 05:59:00')]);
    await reader(q).readChunk(encodeDeviceCursor('D2'), 1000);

    const { sql, params } = q.calls[0];
    expect(sql).toMatch(/ORDER BY device_id/i);
    expect(sql).toMatch(/device_id > \?/);
    expect(params).toEqual(['D2']);
  });

  it('NEVER lets the mutating latest_gps_datetime drive the scan (no ts comparison, no ts param) — on any page', async () => {
    // The correctness invariant: scan membership/order depends solely on the immutable device_id, so a
    // device that advances (or backdates) its latest_gps_datetime mid-run cannot be re-read or skipped.
    const first = fakeQuery([vm('D1', '2026-07-02 05:57:00')]);
    await reader(first).readChunk(null, 10);
    const cont = fakeQuery([vm('D9', '2026-07-02 06:10:00')]);
    await reader(cont).readChunk(encodeDeviceCursor('D8'), 10);

    for (const call of [first.calls[0], cont.calls[0]]) {
      expect(call.sql).not.toMatch(/latest_gps_datetime\s*(>=|>|<|<=|=)\s*\?/i); // no watermark/keyset on the ts
      expect(call.params.some((p) => typeof p === 'string' && /\d{4}-\d{2}-\d{2}/.test(p))).toBe(false);
    }
  });

  it('advances the cursor from the last DB row scanned, not the mapped/filtered set', async () => {
    // A bogus-future row is dropped from output but still counts for exhaustion + cursor advance, so a
    // dropped tail row never causes a re-read loop. Full chunk (2==limit) ⇒ continue past the last row.
    const q = fakeQuery([vm('DPRESENT', '2026-07-02 05:57:47'), vm('DFUTURE', '2027-01-01 00:00:00')]);
    const chunk = await reader(q).readChunk(null, 2);
    expect(chunk.rows.map((r) => r.deviceId)).toEqual(['DPRESENT']); // future row dropped
    expect(chunk.nextCursor).toBe(encodeDeviceCursor('DFUTURE')); // …but cursor rides the real last row
  });

  it('schema-qualifies tb_vehiclemaster with the widgets schema when supplied (default schema is ap_masters)', async () => {
    // Regression (2026-07-14): the pool's default schema is ap_masters, where tb_vehiclemaster does not
    // exist. Production must qualify the read with the ap_widgets schema or every run fails ER_NO_SUCH_TABLE.
    const q = fakeQuery([vm('D1', '2026-07-02 05:57:00')]);
    const r = new AutoPlantSourceReader({ query: q.fn, now: () => NOW, widgetsSchema: 'ap_widgets' });
    await r.readChunk(null, 10);
    expect(q.calls[0].sql).toMatch(/FROM `ap_widgets`\.tb_vehiclemaster/i);
    expect(q.calls[0].sql).not.toMatch(/FROM tb_vehiclemaster/i); // never leans on the default schema
  });

  it('signals exhaustion with a null cursor on an empty source', async () => {
    const q = fakeQuery([]);
    const chunk = await reader(q).readChunk(null, 1000);
    expect(chunk.rows).toHaveLength(0);
    expect(chunk.nextCursor).toBeNull();
  });
});
