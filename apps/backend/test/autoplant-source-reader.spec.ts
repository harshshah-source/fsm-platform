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
    // The source column is UTC, so the wall clock IS the instant — no offset applied (#222).
    expect(chunk.rows[0].gpsDatetime.toISOString()).toBe('2026-07-02T05:57:47.000Z');
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

  /**
   * #222 P6 — the reader must COUNT what the skew guard drops. The operator's reasoning for rejecting
   * the ~5 IST-writers over accepting them was that *"a dropped device is visible as a gap"*; before
   * this the reader discarded them with `if (row) mapped.push(row)` and no counter, which would have
   * made the drop exactly as invisible as the behaviour it replaced.
   */
  it('tallies skew-guard rejections per chunk instead of dropping them silently', async () => {
    const q = fakeQuery([
      vm('DGOOD', '2026-07-02 11:57:47'),
      vm('DIST', '2026-07-02 17:30:00'), // IST written into the UTC column: now + 5:30
      vm('DSENTINEL', '1970-01-01 00:00:00'),
      vm('DNODEVICE', '2026-07-02 11:00:00', { device_id: null }),
    ]);
    const chunk = await reader(q).readChunk(null, 10);

    expect(chunk.rows.map((r) => r.deviceId)).toEqual(['DGOOD']);
    expect(chunk.rejected).toEqual({ FUTURE_SKEW: 1, IMPLAUSIBLE_PAST: 1 });
  });

  it('reports no rejection tally when every row is clean', async () => {
    const q = fakeQuery([vm('D1', '2026-07-02 11:57:00'), vm('D2', '2026-07-02 11:58:00')]);
    const chunk = await reader(q).readChunk(null, 10);
    expect(chunk.rejected).toBeUndefined();
  });
});


/**
 * #299 (AR-1 + AR-2) — the containment, proved where it matters: over a whole chunk, and across runs.
 *
 * The mapping spec proves one row degrades correctly. This proves the consequence the issue is
 * actually about — that the other 89 rows in the chunk still arrive, and that the *next* run gets past
 * the same poison row rather than dying at it again. That second half is the whole of AR-1: the scan
 * is deterministic (`ORDER BY device_id`, restarted from `cursor = null` every run), so before this a
 * failure at one row was a permanent ceiling on the fleet — every device sorting after it was never
 * ingested again, at any point in the future, until the source row was edited by hand.
 */
describe('#299 — poison containment over a chunk', () => {
  it('AR-1: an unparseable timestamp costs its own row and nothing else', async () => {
    const q = fakeQuery([
      vm('D1', '2026-07-02 11:00:00'),
      vm('DPOISON', 'not-a-date'),
      vm('D3', '2026-07-02 11:02:00'),
    ]);
    // Before #299 this call REJECTED — the throw came out of the row loop, out of readChunk, and the
    // worker recorded it as a source-read failure and stopped draining. Nothing after DPOISON was read.
    const chunk = await reader(q).readChunk(null, 10);

    expect(chunk.rows.map((r) => r.deviceId)).toEqual(['D1', 'D3']);
    expect(chunk.rejected).toEqual({ UNPARSEABLE_TIMESTAMP: 1 });
    // The cursor rides the last RAW row, not the last mapped one, so the scan walks past the poison
    // row rather than re-reading it for ever.
    expect(chunk.nextCursor).toBeNull(); // short page → source exhausted
  });

  it('AR-1 replay: the NEXT run reads straight past the same row, because nothing throws', async () => {
    // The scan restarts from cursor=null every run and orders by the immutable device_id, so "the next
    // run" is the identical query over the identical rows. The defect was that this was deterministic
    // FAILURE; the fix makes it deterministic SKIP.
    const rows = [vm('D1', '2026-07-02 11:00:00'), vm('DPOISON', 'not-a-date'), vm('D3', '2026-07-02 11:02:00')];
    const first = await reader(fakeQuery(rows)).readChunk(null, 10);
    const second = await reader(fakeQuery(rows)).readChunk(null, 10);

    expect(second.rows.map((r) => r.deviceId)).toEqual(['D1', 'D3']);
    expect(second.rows.map((r) => r.deviceId)).toEqual(first.rows.map((r) => r.deviceId));
    expect(second.rejected).toEqual({ UNPARSEABLE_TIMESTAMP: 1 });
  });

  it('AR-1 at scale: 89 of 90 rows survive one poison row, and the poison row is the one named', async () => {
    // The real chunk size the issue measured. A count is not enough on its own — the assertion is that
    // the survivors are exactly the non-poison rows, so containment cannot pass by dropping the chunk.
    const rows = Array.from({ length: 90 }, (_, i) =>
      vm(`D${String(i).padStart(2, '0')}`, i === 40 ? 'not-a-date' : '2026-07-02 11:00:00'),
    );
    const chunk = await reader(fakeQuery(rows)).readChunk(null, 90);

    expect(chunk.rows).toHaveLength(89);
    expect(chunk.rows.map((r) => r.deviceId)).not.toContain('D40');
    expect(chunk.rejected).toEqual({ UNPARSEABLE_TIMESTAMP: 1 });
  });

  it('AR-2: an out-of-range reading costs its field, not its row and not its chunk', async () => {
    const q = fakeQuery([
      vm('DGOOD', '2026-07-02 11:00:00'),
      // The measured poison: 99999 bound for a SmallInt. `createMany` is atomic per chunk, so this one
      // value used to fail all 90 rows, through all three retries, on every 30-minute tick, for ever.
      vm('DRANGE', '2026-07-02 11:01:00', { gpssignal: { power: { mainstatus: '99999', mainvoltage: null } } }),
    ]);
    const chunk = await reader(q).readChunk(null, 10);

    // Both devices ingest. The bad reading is gone; the ping that proves DRANGE is alive is not.
    expect(chunk.rows.map((r) => r.deviceId)).toEqual(['DGOOD', 'DRANGE']);
    expect(chunk.rows[1].mainsStatus).toBeNull();
    expect(chunk.rows[1].gpsDatetime.toISOString()).toBe('2026-07-02T11:01:00.000Z');
    expect(chunk.repaired).toEqual({ RANGE_MAINS_STATUS: 1 });
    // Not a rejection: no device lost its ping, so the rejection tally must stay empty.
    expect(chunk.rejected).toBeUndefined();
  });

  it('reports the two tallies separately when a chunk carries both kinds of damage', async () => {
    const q = fakeQuery([
      vm('DGOOD', '2026-07-02 11:00:00'),
      vm('DPOISON', 'not-a-date'),
      vm('DIST', '2026-07-02 17:30:00'), // IST written into the UTC column — the #222 P6 signature
      vm('DRANGE', '2026-07-02 11:01:00', { latitude: 200 }),
    ]);
    const chunk = await reader(q).readChunk(null, 10);

    expect(chunk.rows.map((r) => r.deviceId)).toEqual(['DGOOD', 'DRANGE']);
    expect(chunk.rejected).toEqual({ UNPARSEABLE_TIMESTAMP: 1, FUTURE_SKEW: 1 });
    expect(chunk.repaired).toEqual({ RANGE_LAT: 1 });
  });

  it('reports no repair tally when every reading is in range', async () => {
    const q = fakeQuery([vm('D1', '2026-07-02 11:57:00'), vm('D2', '2026-07-02 11:58:00')]);
    const chunk = await reader(q).readChunk(null, 10);
    expect(chunk.repaired).toBeUndefined();
    expect(chunk.rejected).toBeUndefined();
  });
});
