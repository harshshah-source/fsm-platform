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
          await this.prisma.snapshotRunChunk.update({
            where: { id: record.id },
            data: { status: 'FAILED', retryCount: outcome.attempts - 1, error: outcome.error },
          });
        }
      }

      cursor = chunk.nextCursor;
      if (cursor === null) break;
    }

    const status: SnapshotRunOutcome =
      failed === 0 ? 'SUCCESS' : succeeded === 0 ? 'FAILED' : 'PARTIAL';

    await this.runs.finishRun(runId, {
      status,
      dataAsOf: status === 'FAILED' ? null : dataAsOf,
      cursor: dataAsOf ? dataAsOf.toISOString() : null,
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
