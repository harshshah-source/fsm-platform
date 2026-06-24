import {
  InMemorySourceReader,
  type SourceReader,
  type SourceSnapshotRow,
} from '../src/ingestion/source-reader';

/**
 * Issue 04, slice 2 — the AutoPlant source seam.
 *
 * `SourceReader` is the interface the SnapshotIngestionWorker reads through; the real AutoPlant
 * DB connection swaps in behind it later (HITL — external access). `InMemorySourceReader` is the
 * mock the worker is built and tested against. These tests pin the cursor-based chunk contract.
 */

const row = (deviceId: number, minute: number): SourceSnapshotRow => ({
  deviceId: BigInt(deviceId),
  gpsDatetime: new Date(Date.UTC(2026, 5, 19, 8, minute, 0)),
  lat: 12.9 + deviceId / 1000,
  lon: 77.5 + deviceId / 1000,
});

/** Walk a reader to exhaustion, collecting rows and counting reads. */
const drain = async (
  reader: SourceReader,
  chunkSize: number,
): Promise<{ rows: SourceSnapshotRow[]; reads: number }> => {
  const rows: SourceSnapshotRow[] = [];
  let cursor: string | null = null;
  let reads = 0;
  // Bounded to avoid a runaway loop if the contract is broken.
  for (let i = 0; i < 1000; i++) {
    const chunk = await reader.readChunk(cursor, chunkSize);
    reads++;
    rows.push(...chunk.rows);
    cursor = chunk.nextCursor;
    if (cursor === null) break;
  }
  return { rows, reads };
};

describe('Issue 04 slice 2 — SourceReader (AutoPlant seam)', () => {
  it('drains every source row exactly once, in order', async () => {
    const source = [row(1, 0), row(2, 1), row(3, 2), row(4, 3), row(5, 4)];
    const reader = new InMemorySourceReader(source);

    const { rows } = await drain(reader, 2);

    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.deviceId)).toEqual([1n, 2n, 3n, 4n, 5n]);
  });

  it('signals exhaustion with a null cursor', async () => {
    const reader = new InMemorySourceReader([row(1, 0), row(2, 1)]);

    const first = await reader.readChunk(null, 1);
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = await reader.readChunk(first.nextCursor, 1);
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('does not require an extra empty read when the chunk size divides evenly', async () => {
    const reader = new InMemorySourceReader([row(1, 0), row(2, 1), row(3, 2), row(4, 3)]);

    const { rows, reads } = await drain(reader, 2);

    expect(rows).toHaveLength(4);
    expect(reads).toBe(2); // exactly two full chunks, then a null cursor
  });

  it('yields no rows and a null cursor for an empty source', async () => {
    const reader = new InMemorySourceReader([]);

    const chunk = await reader.readChunk(null, 10);

    expect(chunk.rows).toHaveLength(0);
    expect(chunk.nextCursor).toBeNull();
  });

  it('respects the requested chunk size', async () => {
    const reader = new InMemorySourceReader([row(1, 0), row(2, 1), row(3, 2)]);

    const chunk = await reader.readChunk(null, 2);

    expect(chunk.rows).toHaveLength(2);
  });
});
