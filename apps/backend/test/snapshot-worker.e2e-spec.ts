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
 * Issue 04, slice 5 — the SnapshotIngestionWorker composing slices 2–4.
 *
 * Opens a run, drains the source in cursor chunks, records each chunk in `snapshot_run_chunks`
 * with per-chunk retry (chunk-independent), and finalizes: SUCCESS (all chunks ok), PARTIAL (some
 * failed, some ok), or FAILED (none ok). `data_as_of` is the max ingested `gps_datetime`.
 */
const DEV = (n: number): string => String(9_100_000 + n);

const row = (deviceId: string, minute: number): SourceSnapshotRow => ({
  deviceId,
  gpsDatetime: new Date(Date.UTC(2026, 5, 19, 8, minute, 0)),
  lat: 12.97,
  lon: 77.59,
});

/** Fails the first `failTimes` ingest calls, then delegates — a transient DB error. */
class FlakyWriter implements ChunkWriter {
  private calls = 0;
  constructor(
    private readonly real: ChunkWriter,
    private readonly failTimes: number,
  ) {}
  async ingestChunk(runId: bigint, rows: readonly SourceSnapshotRow[]) {
    this.calls++;
    if (this.calls <= this.failTimes) throw new Error('transient db error');
    return this.real.ingestChunk(runId, rows);
  }
}

/** Always throws for a chunk whose first row is the poison device; else delegates. */
class PoisonWriter implements ChunkWriter {
  constructor(
    private readonly real: ChunkWriter,
    private readonly poison: bigint,
  ) {}
  async ingestChunk(runId: bigint, rows: readonly SourceSnapshotRow[]) {
    if (rows[0]?.deviceId === this.poison) throw new Error('poison chunk');
    return this.real.ingestChunk(runId, rows);
  }
}

class DeadWriter implements ChunkWriter {
  async ingestChunk(): Promise<{ inserted: number }> {
    throw new Error('db down');
  }
}

/**
 * Delivers `goodChunks` normal chunks, then throws on the next read — a source/VPN drop mid-scan.
 * This is the orphan path that stranded run 456: a read throwing outside the finalize block left the
 * run RUNNING forever, so recompute never ran and the dashboards went empty.
 */
class ReadThrowsMidScan implements SourceReader {
  private reads = 0;
  constructor(
    private readonly rows: readonly SourceSnapshotRow[],
    private readonly goodChunks: number,
  ) {}
  async readChunk(cursor: string | null, chunkSize: number): Promise<SourceChunk> {
    if (this.reads >= this.goodChunks) throw new Error('source read failed mid-scan (VPN drop)');
    const start = cursor === null ? 0 : Number(cursor);
    const slice = this.rows.slice(start, start + chunkSize);
    this.reads += 1;
    // Always signal more to come so the worker issues another read — which throws.
    return { rows: [...slice], nextCursor: String(start + slice.length) };
  }
}

describe('Issue 04 slice 5 — SnapshotIngestionWorker', () => {
  let prisma: PrismaService;
  let runs: SnapshotRunService;
  let realWriter: SnapshotIngestionService;
  const created: bigint[] = [];

  const makeWorker = (writer: ChunkWriter, source: InMemorySourceReader) =>
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

  it('drains the source across chunks and finishes SUCCESS with data_as_of = max gps', async () => {
    const source = new InMemorySourceReader([
      row(DEV(1), 0),
      row(DEV(2), 1),
      row(DEV(3), 2),
      row(DEV(4), 3),
      row(DEV(5), 4),
    ]);

    const result = await makeWorker(realWriter, source).run({ chunkSize: 2 });
    created.push(result.runId);

    expect(result.status).toBe('SUCCESS');
    expect(result.chunks).toBe(3);
    expect(result.inserted).toBe(5);

    const run = await prisma.snapshotRun.findUnique({ where: { runId: result.runId } });
    expect(run?.dataAsOf?.toISOString()).toBe(new Date(Date.UTC(2026, 5, 19, 8, 4, 0)).toISOString());

    const rawCount = await prisma.rawDeviceSnapshot.count({ where: { runId: result.runId } });
    expect(rawCount).toBe(5);
    const chunks = await prisma.snapshotRunChunk.findMany({ where: { runId: result.runId } });
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.status === 'SUCCESS')).toBe(true);
  });

  it('retries a transiently failing chunk and still succeeds', async () => {
    const source = new InMemorySourceReader([row(DEV(11), 0), row(DEV(12), 1), row(DEV(13), 2)]);
    const writer = new FlakyWriter(realWriter, 2); // fail twice, succeed on the 3rd attempt

    const result = await makeWorker(writer, source).run({ chunkSize: 3, retryDelayMs: 0 });
    created.push(result.runId);

    expect(result.status).toBe('SUCCESS');
    expect(result.inserted).toBe(3);
    const chunk = (await prisma.snapshotRunChunk.findMany({ where: { runId: result.runId } }))[0];
    expect(chunk.status).toBe('SUCCESS');
    expect(chunk.retryCount).toBe(2);
  });

  it('fails one chunk after exhausting retries and finishes PARTIAL when another succeeds', async () => {
    const poison = DEV(21);
    const source = new InMemorySourceReader([row(poison, 0), row(DEV(22), 1)]);
    const writer = new PoisonWriter(realWriter, poison);

    const result = await makeWorker(writer, source).run({ chunkSize: 1, retryDelayMs: 0 });
    created.push(result.runId);

    expect(result.status).toBe('PARTIAL');
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.inserted).toBe(1);

    const run = await prisma.snapshotRun.findUnique({ where: { runId: result.runId } });
    expect(run?.dataAsOf?.toISOString()).toBe(new Date(Date.UTC(2026, 5, 19, 8, 1, 0)).toISOString());

    const failed = (await prisma.snapshotRunChunk.findMany({ where: { runId: result.runId } })).find(
      (c) => c.status === 'FAILED',
    );
    expect(failed?.error).toBeTruthy();
  });

  it('finishes FAILED with null data_as_of when every chunk fails', async () => {
    const source = new InMemorySourceReader([row(DEV(31), 0), row(DEV(32), 1)]);

    const result = await makeWorker(new DeadWriter(), source).run({ chunkSize: 1, retryDelayMs: 0 });
    created.push(result.runId);

    expect(result.status).toBe('FAILED');
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.inserted).toBe(0);

    const run = await prisma.snapshotRun.findUnique({ where: { runId: result.runId } });
    expect(run?.dataAsOf).toBeNull();
  });

  it('finalizes PARTIAL (never orphans RUNNING) when a read throws after some chunks landed', async () => {
    // One chunk ingests, then the second read throws — the run must terminate, not hang RUNNING.
    const source = new ReadThrowsMidScan([row(DEV(41), 0), row(DEV(42), 1)], 1);

    const result = await makeWorker(realWriter, source).run({ chunkSize: 1, retryDelayMs: 0 });
    created.push(result.runId);

    expect(result.status).toBe('PARTIAL');
    expect(result.succeeded).toBe(1);

    const run = await prisma.snapshotRun.findUnique({ where: { runId: result.runId } });
    expect(run?.status).toBe('PARTIAL');
    expect(run?.finishedAt).not.toBeNull();
    // Display watermark advanced only to the ingested high-water; resume cursor lets the next run
    // re-read forward from there (idempotent), so no ping is silently skipped.
    expect(run?.dataAsOf?.toISOString()).toBe(new Date(Date.UTC(2026, 5, 19, 8, 0, 0)).toISOString());
    expect(run?.cursor).toBe(new Date(Date.UTC(2026, 5, 19, 8, 0, 0)).toISOString());
  });

  it('finalizes FAILED with null data_as_of when the very first read throws', async () => {
    const source = new ReadThrowsMidScan([row(DEV(51), 0)], 0);

    const result = await makeWorker(realWriter, source).run({ chunkSize: 1, retryDelayMs: 0 });
    created.push(result.runId);

    expect(result.status).toBe('FAILED');
    expect(result.succeeded).toBe(0);

    const run = await prisma.snapshotRun.findUnique({ where: { runId: result.runId } });
    expect(run?.status).toBe('FAILED');
    expect(run?.finishedAt).not.toBeNull();
    expect(run?.dataAsOf).toBeNull();
  });

  it('finishes SUCCESS with no chunks for an empty source', async () => {
    const result = await makeWorker(realWriter, new InMemorySourceReader([])).run();
    created.push(result.runId);

    expect(result.status).toBe('SUCCESS');
    expect(result.chunks).toBe(0);
    expect(result.inserted).toBe(0);
  });
});
