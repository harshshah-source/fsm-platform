import {
  SnapshotIngestionWorker,
  type ChunkWriter,
} from '../src/ingestion/snapshot-ingestion.worker';
import { SnapshotIngestionService } from '../src/ingestion/snapshot-ingestion.service';
import { SnapshotRunService } from '../src/ingestion/snapshot-run.service';
import {
  InMemorySourceReader,
  type SourceChunk,
  type SourceReader,
  type SourceSnapshotRow,
} from '../src/ingestion/source-reader';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 97 Slice 3 (review A3) — PARTIAL-cursor lower-bound fix. On a PARTIAL run the resume cursor
 * used to advance to the high-water mark of *succeeded* chunks, so a permanently-failed middle
 * chunk's window fell behind the watermark forever (loss biased toward dying devices' last-ever
 * ping). The fix: on PARTIAL, persist `snapshot_runs.cursor` at the first failed chunk's
 * `min(gpsDatetime)` so the next run re-reads that window; `ON CONFLICT DO NOTHING` on
 * `(device_id, gps_datetime)` makes the overlap free. `data_as_of` (the display watermark) keeps its
 * conservative succeeded-high-water semantics — the two cursors are deliberately asymmetric.
 */
const DEV = (n: number): string => String(9_300_000 + n);

const T = (minute: number): Date => new Date(Date.UTC(2026, 5, 20, 9, minute, 0));

const row = (deviceId: string, minute: number): SourceSnapshotRow => ({
  deviceId,
  gpsDatetime: T(minute),
  lat: 12.97,
  lon: 77.59,
});

/** Always throws for a chunk whose first row is the poison device; else delegates. */
class PoisonWriter implements ChunkWriter {
  constructor(
    private readonly real: ChunkWriter,
    private readonly poison: string,
  ) {}
  async ingestChunk(runId: bigint, rows: readonly SourceSnapshotRow[]) {
    if (rows[0]?.deviceId === this.poison) throw new Error('poison chunk');
    return this.real.ingestChunk(runId, rows);
  }
}

/**
 * Mirrors `AutoPlantSourceReader`'s cross-run resume seam: a null cursor loads the last persisted
 * watermark and serves only rows `>=` it; intra-run continuation is index-keyset like
 * `InMemorySourceReader`. (The resume watermark cannot change mid-run — only `finishRun` writes it —
 * so re-loading it per read is stable.)
 */
class ResumeAwareSourceReader implements SourceReader {
  constructor(
    private readonly rows: readonly SourceSnapshotRow[],
    private readonly loadResumeCursor: () => Promise<string | null>,
  ) {}
  async readChunk(cursor: string | null, chunkSize: number): Promise<SourceChunk> {
    const resume = await this.loadResumeCursor();
    const floor = resume ? new Date(resume) : null;
    const window = floor ? this.rows.filter((r) => r.gpsDatetime >= floor) : this.rows;
    const start = cursor === null ? 0 : Number(cursor);
    const slice = window.slice(start, start + chunkSize);
    const nextIndex = start + slice.length;
    const exhausted = slice.length === 0 || nextIndex >= window.length;
    return { rows: [...slice], nextCursor: exhausted ? null : String(nextIndex) };
  }
}

describe('Issue 97 Slice 3 — PARTIAL-run resume cursor lower bound', () => {
  let prisma: PrismaService;
  let runs: SnapshotRunService;
  let realWriter: SnapshotIngestionService;
  const created: bigint[] = [];

  const makeWorker = (writer: ChunkWriter, source: SourceReader) =>
    new SnapshotIngestionWorker(runs, writer, source, prisma);

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    runs = new SnapshotRunService(prisma);
    realWriter = new SnapshotIngestionService(prisma);
  });

  beforeEach(async () => {
    await prisma.snapshotRun.deleteMany({ where: { status: 'RUNNING' } });
  });

  afterEach(async () => {
    if (created.length > 0) {
      await prisma.snapshotRunChunk.deleteMany({ where: { runId: { in: created } } });
      await prisma.rawDeviceSnapshot.deleteMany({ where: { runId: { in: created } } });
      await prisma.snapshotRun.deleteMany({ where: { runId: { in: created } } });
      created.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('PARTIAL: persists cursor at the first failed chunk lower bound, not the succeeded high-water mark', async () => {
    const poison = DEV(1);
    // Three 1-row chunks: minute 0 succeeds, minute 1 (poison) fails all retries, minute 2 succeeds.
    const source = new InMemorySourceReader([row(DEV(0), 0), row(poison, 1), row(DEV(2), 2)]);

    const result = await makeWorker(new PoisonWriter(realWriter, poison), source).run({
      chunkSize: 1,
      retryDelayMs: 0,
    });
    created.push(result.runId);
    expect(result.status).toBe('PARTIAL');

    const run = await prisma.snapshotRun.findUnique({ where: { runId: result.runId } });
    // Resume cursor = failed window's lower bound → the next run re-reads minute 1 onward.
    expect(run?.cursor).toBe(T(1).toISOString());
    // Display watermark keeps the conservative succeeded-high-water semantics.
    expect(run?.dataAsOf?.toISOString()).toBe(T(2).toISOString());
  });

  it('SUCCESS: cursor semantics unchanged — resume cursor = data_as_of high-water mark', async () => {
    const source = new InMemorySourceReader([row(DEV(10), 0), row(DEV(11), 1), row(DEV(12), 2)]);

    const result = await makeWorker(realWriter, source).run({ chunkSize: 2 });
    created.push(result.runId);
    expect(result.status).toBe('SUCCESS');

    const run = await prisma.snapshotRun.findUnique({ where: { runId: result.runId } });
    expect(run?.cursor).toBe(T(2).toISOString());
    expect(run?.dataAsOf?.toISOString()).toBe(T(2).toISOString());
  });

  it('FAILED: semantics unchanged — null data_as_of AND null cursor (cold retry, banner unmoved)', async () => {
    const poison = DEV(20);
    const source = new InMemorySourceReader([row(poison, 0)]);

    const result = await makeWorker(new PoisonWriter(realWriter, poison), source).run({
      chunkSize: 1,
      retryDelayMs: 0,
    });
    created.push(result.runId);
    expect(result.status).toBe('FAILED');

    const run = await prisma.snapshotRun.findUnique({ where: { runId: result.runId } });
    expect(run?.dataAsOf).toBeNull();
    expect(run?.cursor).toBeNull();
  });

  it('two-run sequence: the failed window is re-read, no ping lost, no duplicate rows', async () => {
    const poison = DEV(30);
    const rows = [row(DEV(29), 0), row(poison, 1), row(DEV(31), 2)];

    // Run 1: middle chunk (minute 1) fails permanently → PARTIAL, cursor dropped back to T(1).
    const run1 = await makeWorker(
      new PoisonWriter(realWriter, poison),
      new ResumeAwareSourceReader(rows, () => runs.lastResumeCursor()),
    ).run({ chunkSize: 1, retryDelayMs: 0 });
    created.push(run1.runId);
    expect(run1.status).toBe('PARTIAL');
    expect(await runs.lastResumeCursor()).toBe(T(1).toISOString());

    // Run 2: resumes >= T(1) → re-reads minutes 1 and 2; the healthy writer ingests the missing
    // minute-1 ping and ON CONFLICT skips the already-present minute-2 row.
    const run2 = await makeWorker(
      realWriter,
      new ResumeAwareSourceReader(rows, () => runs.lastResumeCursor()),
    ).run({ chunkSize: 1, retryDelayMs: 0 });
    created.push(run2.runId);
    expect(run2.status).toBe('SUCCESS');
    expect(run2.inserted).toBe(1); // only the previously-lost ping — the overlap deduped to zero

    // No ping lost: every source row is present exactly once across both runs.
    for (const r of rows) {
      const count = await prisma.rawDeviceSnapshot.count({
        where: { deviceId: r.deviceId, gpsDatetime: r.gpsDatetime },
      });
      expect(count).toBe(1);
    }
  });
});
