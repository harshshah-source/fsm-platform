import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SnapshotRunService, type SnapshotRunOutcome } from './snapshot-run.service';
import type { SourceReader, SourceSnapshotRow } from './source-reader';

/** The chunk write seam — `SnapshotIngestionService` satisfies this; tests inject fault wrappers. */
export interface ChunkWriter {
  ingestChunk(runId: bigint, rows: readonly SourceSnapshotRow[]): Promise<{ inserted: number }>;
}

export interface SnapshotRunResult {
  runId: bigint;
  status: SnapshotRunOutcome;
  chunks: number;
  succeeded: number;
  failed: number;
  inserted: number;
}

export interface SnapshotRunOptions {
  /** Rows pulled per source read (LLD default ~1000). */
  chunkSize?: number;
  /** Attempts per chunk before it is marked FAILED (LLD "retry ×3"). */
  maxAttempts?: number;
  /** Base for exponential backoff between attempts; 0 in tests. */
  retryDelayMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * SnapshotIngestionWorker (LLD §6) — composes the run lifecycle (slice 4), the cursor source seam
 * (slice 2), and the idempotent chunk writer (slice 3).
 *
 * Opens a RUNNING run, drains the source chunk-by-chunk, and processes each chunk with independent
 * retry (a chunk failing does not abort its siblings). Each chunk is recorded in
 * `snapshot_run_chunks`. The run finalizes SUCCESS (all chunks ok), PARTIAL (mixed), or FAILED
 * (none ok); `data_as_of` is the high-water `gps_datetime` across successfully-ingested chunks, and
 * is left null for a fully FAILED run so the dashboard banner never advances on bad data.
 */
@Injectable()
export class SnapshotIngestionWorker {
  constructor(
    private readonly runs: SnapshotRunService,
    private readonly writer: ChunkWriter,
    private readonly source: SourceReader,
    private readonly prisma: PrismaService,
  ) {}

  async run(opts: SnapshotRunOptions = {}): Promise<SnapshotRunResult> {
    const chunkSize = opts.chunkSize ?? 1000;
    const maxAttempts = opts.maxAttempts ?? 3;
    const retryDelayMs = opts.retryDelayMs ?? 200;

    const { runId } = await this.runs.startRun();

    let cursor: string | null = null;
    let chunkNo = 0;
    let succeeded = 0;
    let failed = 0;
    let inserted = 0;
    let dataAsOf: Date | null = null;
    let firstFailedLowerBound: Date | null = null;
    // A source read (not a chunk write) throwing mid-scan — e.g. the AutoPlant VPN dropping. This is
    // the path that orphaned run 456: the throw escaped `run()` before `finishRun`, so the run hung
    // RUNNING forever and device-state recompute never ran → empty dashboards. We now catch it, stop
    // draining, and fall through to finalize the run so it can never be left RUNNING.
    let readError: string | null = null;

    try {
      for (;;) {
        const chunk = await this.source.readChunk(cursor, chunkSize);

        if (chunk.rows.length > 0) {
          chunkNo += 1;
          const record = await this.prisma.snapshotRunChunk.create({
            data: { runId, chunkNo, status: 'PENDING' },
          });
          const outcome = await this.processChunk(runId, chunk.rows, maxAttempts, retryDelayMs);

          if (outcome.ok) {
            succeeded += 1;
            inserted += outcome.inserted;
            dataAsOf = maxDate(dataAsOf, chunk.rows);
            await this.prisma.snapshotRunChunk.update({
              where: { id: record.id },
              data: { status: 'SUCCESS', retryCount: outcome.attempts - 1 },
            });
          } else {
            failed += 1;
            if (firstFailedLowerBound === null) firstFailedLowerBound = minDate(chunk.rows);
            await this.prisma.snapshotRunChunk.update({
              where: { id: record.id },
              data: { status: 'FAILED', retryCount: outcome.attempts - 1, error: outcome.error },
            });
          }
        }

        cursor = chunk.nextCursor;
        if (cursor === null) break;
      }
    } catch (e) {
      readError = e instanceof Error ? e.message : String(e);
    }

    // A mid-scan read failure can never finalize SUCCESS (data past the failure point was never read):
    // PARTIAL if any chunk landed so the display watermark holds and the next run resumes forward,
    // else FAILED. Absent a read error, the normal all/none/mixed rule applies.
    const status: SnapshotRunOutcome =
      readError !== null
        ? succeeded === 0
          ? 'FAILED'
          : 'PARTIAL'
        : failed === 0
          ? 'SUCCESS'
          : succeeded === 0
            ? 'FAILED'
            : 'PARTIAL';

    // Two cursors, deliberately asymmetric (review A3): `dataAsOf` is the conservative DISPLAY
    // watermark (high-water of succeeded chunks; the freshness banner never advances on lost data),
    // while `resumeCursor` is the optimistic RE-READ floor — on PARTIAL it drops back to the first
    // failed chunk's lower bound so the next run re-reads that window (`>=` resume in the reader;
    // the `(device_id, gps_datetime)` ON CONFLICT makes the overlap free).
    // On a write-failure PARTIAL, drop back to the first failed chunk's lower bound to re-read it.
    // On a read-failure PARTIAL there is no failed chunk (`firstFailedLowerBound` is null), so resume
    // from the ingested high-water — the next run reads forward from where the source read died.
    const resumeCursor = status === 'PARTIAL' ? (firstFailedLowerBound ?? dataAsOf) : dataAsOf;

    await this.runs.finishRun(runId, {
      status,
      dataAsOf: status === 'FAILED' ? null : dataAsOf,
      cursor: resumeCursor ? resumeCursor.toISOString() : null,
    });

    return { runId, status, chunks: chunkNo, succeeded, failed, inserted };
  }

  private async processChunk(
    runId: bigint,
    rows: readonly SourceSnapshotRow[],
    maxAttempts: number,
    retryDelayMs: number,
  ): Promise<{ ok: true; inserted: number; attempts: number } | { ok: false; attempts: number; error: string }> {
    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const { inserted } = await this.writer.ingestChunk(runId, rows);
        return { ok: true, inserted, attempts: attempt };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (attempt < maxAttempts) await sleep(retryDelayMs * 2 ** (attempt - 1));
      }
    }
    return { ok: false, attempts: maxAttempts, error: lastError };
  }
}

const maxDate = (current: Date | null, rows: readonly SourceSnapshotRow[]): Date => {
  let max = current;
  for (const r of rows) {
    if (max === null || r.gpsDatetime > max) max = r.gpsDatetime;
  }
  return max as Date;
};

/** Lower bound of a chunk's window — the PARTIAL resume floor. Chunks are only recorded non-empty. */
const minDate = (rows: readonly SourceSnapshotRow[]): Date => {
  let min: Date | null = null;
  for (const r of rows) {
    if (min === null || r.gpsDatetime < min) min = r.gpsDatetime;
  }
  return min as Date;
};
