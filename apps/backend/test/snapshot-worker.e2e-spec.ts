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

  // Typed as the interface the worker actually takes. It was narrowed to the in-memory implementation,
  // which every reader-substituting test in this file already had to violate; #261's probe made that a
  // compile error rather than a latent one.
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

  /**
   * #261 (folding #132) — the beat has to happen **per chunk**, not once at run start.
   *
   * A single beat at `startRun` would satisfy "the column is populated" and change nothing: the reaper
   * would still be judging the run on a timestamp taken before any work began, which is `started_at`
   * under another name. What buys a long run its next window is the work itself reporting progress, so
   * this reads `heartbeat_at` out of the database immediately before each source read and requires it
   * to have moved forward between chunks.
   */
  it('beats once per chunk, so a long drain keeps buying itself the next window', async () => {
    const beats: (Date | null)[] = [];
    const rows = [row(DEV(41), 0), row(DEV(42), 1), row(DEV(43), 2), row(DEV(44), 3), row(DEV(45), 4), row(DEV(46), 5)];
    let runId: bigint | null = null;
    const probing: SourceReader = {
      async readChunk(cursor: string | null, chunkSize: number): Promise<SourceChunk> {
        // The run is the only RUNNING row while this test holds the table (beforeEach clears them).
        const live = await prisma.snapshotRun.findFirst({ where: { status: 'RUNNING' }, orderBy: { runId: 'desc' } });
        if (live) runId = live.runId;
        beats.push(live?.heartbeatAt ?? null);
        // Two consecutive beats inside one millisecond would be indistinguishable in the assertion
        // below; the delay is about the clock's resolution, not about the code under test.
        await new Promise((r) => setTimeout(r, 5));
        const start = cursor === null ? 0 : Number(cursor);
        const slice = rows.slice(start, start + chunkSize);
        const next = start + slice.length;
        return { rows: [...slice], nextCursor: next >= rows.length ? null : String(next) };
      },
    };

    const result = await makeWorker(realWriter, probing).run({ chunkSize: 2 });
    created.push(result.runId);

    expect(result.status).toBe('SUCCESS');
    expect(runId).toBe(result.runId);
    // Three reads: the first sees the beat taken at run start, and each later one must see a newer beat
    // than the read before it — that is one beat per chunk drained.
    expect(beats).toHaveLength(3);
    expect(beats[0]).not.toBeNull();
    expect(beats[1]!.getTime()).toBeGreaterThan(beats[0]!.getTime());
    expect(beats[2]!.getTime()).toBeGreaterThan(beats[1]!.getTime());
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
    // Display watermark advanced only to the ingested high-water, so the freshness banner never
    // claims data the run lost. #324 (F4) — and there is no resume cursor beside it any more: nothing
    // in production ever read one, because `AutoPlantSourceReader` restarts from a null cursor and
    // re-scans every device on the next run regardless. The failed window is re-read by the scan, not
    // by a persisted floor.
    expect(run?.dataAsOf?.toISOString()).toBe(new Date(Date.UTC(2026, 5, 19, 8, 0, 0)).toISOString());
    expect(run?.cursor).toBeNull();
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


/**
 * #299 — the run's verdict, which is what actually decides whether the fleet's pipeline moves.
 *
 * Containment in the mapping layer is only half the fix. The other half is that a run which dropped a
 * poison row must still finalize **SUCCESS**, because the #230 gate
 * (`integration-sync.service.ts`: `ingestComplete = snapshotStatus === 'SUCCESS'`) skips device-state
 * derivation, auto-recovery and ticket creation on anything else — fleet-wide, on every 30-minute
 * tick. A fix that contained the row but left the run PARTIAL would have changed nothing an operator
 * could see.
 *
 * The counters ride the result: #299 explicitly adds no schema, and #300 owns the operator-facing
 * surface built on top of them — including parking the run totals in the existing `chunk_stats`
 * column so they survive the process (the `#300` describe at the foot of this file).
 */
describe('#299 — a contained poison row does not fail the run', () => {
  /** A reader that reports per-chunk tallies the way `AutoPlantSourceReader` does. */
  class TallyingReader implements SourceReader {
    private reads = 0;
    constructor(
      private readonly chunks: ReadonlyArray<{ rows: SourceSnapshotRow[]; rejected?: Record<string, number>; repaired?: Record<string, number> }>,
    ) {}
    async readChunk(): Promise<SourceChunk> {
      const chunk = this.chunks[this.reads];
      this.reads += 1;
      const last = this.reads >= this.chunks.length;
      return { rows: [...chunk.rows], nextCursor: last ? null : String(this.reads), ...chunk };
    }
  }

  it('AC3 — all chunks SUCCESS with rows rejected: the run is SUCCESS, so the #230 gate opens', async () => {
    const source = new TallyingReader([
      { rows: [row(DEV(61), 0), row(DEV(62), 1)], rejected: { UNPARSEABLE_TIMESTAMP: 1 } },
      { rows: [row(DEV(63), 2)], rejected: { UNPARSEABLE_TIMESTAMP: 1, FUTURE_SKEW: 2 }, repaired: { RANGE_MAINS_STATUS: 4 } },
    ]);

    const result = await makeWorker(realWriter, source).run({ chunkSize: 2 });
    created.push(result.runId);

    // The verdict the gate reads. A rejection is a data-quality fact, never a run failure.
    expect(result.status).toBe('SUCCESS');
    expect(result.failed).toBe(0);
    expect(result.inserted).toBe(3);

    const run = await prisma.snapshotRun.findUnique({ where: { runId: result.runId } });
    expect(run?.status).toBe('SUCCESS');
    // `data_as_of` still advances — the surviving rows are real telemetry, and the freshness banner
    // must not stall just because a sibling row was dropped.
    expect(run?.dataAsOf?.toISOString()).toBe(new Date(Date.UTC(2026, 5, 19, 8, 2, 0)).toISOString());
  });

  it('AC2 — the run totals every reason across chunks, rejections and repairs kept apart', async () => {
    const source = new TallyingReader([
      { rows: [row(DEV(64), 0)], rejected: { UNPARSEABLE_TIMESTAMP: 1 }, repaired: { RANGE_LAT: 2 } },
      { rows: [row(DEV(65), 1)], rejected: { UNPARSEABLE_TIMESTAMP: 3, FUTURE_SKEW: 1 }, repaired: { RANGE_LAT: 1, RANGE_SPEED: 5 } },
    ]);

    const result = await makeWorker(realWriter, source).run({ chunkSize: 1 });
    created.push(result.runId);

    // Nothing is silently dropped: every rejected row and every nulled field is countable, by reason.
    expect(result.rejected).toEqual({ UNPARSEABLE_TIMESTAMP: 4, FUTURE_SKEW: 1 });
    expect(result.repaired).toEqual({ RANGE_LAT: 3, RANGE_SPEED: 5 });
  });

  it('reports empty tallies for a clean run rather than omitting them', async () => {
    const result = await makeWorker(realWriter, new InMemorySourceReader([row(DEV(66), 0)])).run();
    created.push(result.runId);

    // `{}` not `undefined`: a caller reading `Object.keys(result.rejected).length` — which is what an
    // alert does — must not have to null-guard the happy path.
    expect(result.rejected).toEqual({});
    expect(result.repaired).toEqual({});
    expect(result.status).toBe('SUCCESS');
  });

  it('AC4 — containment did not swallow real failures: a chunk write error still retries and degrades the run', async () => {
    // The regression the issue names. Row-level containment must not turn a genuine, non-row DB
    // failure into a quiet success — a chunk that fails for a reason that is not one bad row (a
    // connection loss) has to retry, be recorded FAILED, and pull the run down to PARTIAL exactly as
    // before, so the #230 gate still refuses to derive state from a partial read.
    const source = new TallyingReader([
      { rows: [row(DEV(67), 0)], rejected: { UNPARSEABLE_TIMESTAMP: 1 } },
      { rows: [row(DEV(68), 1)] },
    ]);
    const writer = new PoisonWriter(realWriter, DEV(68));

    const result = await makeWorker(writer, source).run({ chunkSize: 1, maxAttempts: 3, retryDelayMs: 0 });
    created.push(result.runId);

    expect(result.status).toBe('PARTIAL');
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    // The rejection tally is still reported alongside the failure — the two are independent facts.
    expect(result.rejected).toEqual({ UNPARSEABLE_TIMESTAMP: 1 });

    const chunks = await prisma.snapshotRunChunk.findMany({ where: { runId: result.runId }, orderBy: { chunkNo: 'asc' } });
    const failedChunk = chunks.find((c) => c.status === 'FAILED');
    expect(failedChunk).toBeTruthy();
    expect(failedChunk!.retryCount).toBe(2); // all three attempts spent, as before
  });
});

/**
 * #300 — the containment counters have to outlive the run.
 *
 * #299 deliberately stopped at the in-process tallies: they rode `SnapshotRunResult` and a WARN log,
 * which is enough for the caller that is standing right there and useless to an operator opening a
 * page an hour later. That is the gap #300 closes, and it closes it on the row the run already
 * writes — `snapshot_runs.chunk_stats`, a JSONB column that has existed since the original schema and
 * had never been written to. No column, no migration, and no input to the SUCCESS/PARTIAL/FAILED
 * verdict, which is computed exactly as before and handed to `finishRun` unchanged.
 */
describe('#300 — the run persists its containment tallies', () => {
  class TallyingReader implements SourceReader {
    private reads = 0;
    constructor(
      private readonly chunks: ReadonlyArray<{ rows: SourceSnapshotRow[]; rejected?: Record<string, number>; repaired?: Record<string, number> }>,
    ) {}
    async readChunk(): Promise<SourceChunk> {
      const chunk = this.chunks[this.reads];
      this.reads += 1;
      const last = this.reads >= this.chunks.length;
      return { rows: [...chunk.rows], nextCursor: last ? null : String(this.reads), ...chunk };
    }
  }

  it('writes the run-total rejected/repaired tallies to chunk_stats', async () => {
    const source = new TallyingReader([
      { rows: [row(DEV(70), 0)], rejected: { UNPARSEABLE_TIMESTAMP: 1 }, repaired: { RANGE_LAT: 2 } },
      { rows: [row(DEV(71), 1)], rejected: { UNPARSEABLE_TIMESTAMP: 3, FUTURE_SKEW: 1 } },
    ]);

    const result = await makeWorker(realWriter, source).run({ chunkSize: 1 });
    created.push(result.runId);

    const run = await prisma.snapshotRun.findUnique({ where: { runId: result.runId } });
    // The same numbers the result reports — one derivation, persisted rather than recomputed, so the
    // alert card and the caller can never disagree about what a run threw away.
    expect(run?.chunkStats).toEqual({
      rejected: { UNPARSEABLE_TIMESTAMP: 4, FUTURE_SKEW: 1 },
      repaired: { RANGE_LAT: 2 },
    });
    expect(result.rejected).toEqual({ UNPARSEABLE_TIMESTAMP: 4, FUTURE_SKEW: 1 });
  });

  it('writes empty tallies for a clean run, not null', async () => {
    const result = await makeWorker(realWriter, new InMemorySourceReader([row(DEV(72), 0)])).run();
    created.push(result.runId);

    const run = await prisma.snapshotRun.findUnique({ where: { runId: result.runId } });
    // A clean run has to be distinguishable from a pre-#300 run that never recorded anything — the
    // alert reads `{}` as "nothing was dropped" and NULL as "we do not know".
    expect(run?.chunkStats).toEqual({ rejected: {}, repaired: {} });
  });

  it('records the tallies of a run that degraded to PARTIAL', async () => {
    // The wedged case, which is the whole point: the run the operator needs the numbers for is the one
    // that did NOT succeed, and `finishRun` must persist them on that path too.
    const source = new TallyingReader([
      { rows: [row(DEV(73), 0)], rejected: { UNPARSEABLE_TIMESTAMP: 2 } },
      { rows: [row(DEV(74), 1)] },
    ]);
    const result = await makeWorker(new PoisonWriter(realWriter, DEV(74)), source).run({
      chunkSize: 1,
      maxAttempts: 2,
      retryDelayMs: 0,
    });
    created.push(result.runId);

    expect(result.status).toBe('PARTIAL');
    const run = await prisma.snapshotRun.findUnique({ where: { runId: result.runId } });
    expect(run?.chunkStats).toEqual({ rejected: { UNPARSEABLE_TIMESTAMP: 2 }, repaired: {} });
  });
});

});
