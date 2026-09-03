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
  /**
   * Rows the reader DROPPED across the whole run, by reason (#222 P6 skew, #299 AR-1 parse) — `{}`
   * when nothing was dropped. Each of these is a device with no ping recorded for this run.
   */
  rejected: Record<string, number>;
  /**
   * Out-of-range telemetry fields nulled across the run, by reason, with their rows ingested
   * (#299 AR-2) — `{}` when nothing was out of range. Not a run failure and not a lost device.
   */
  repaired: Record<string, number>;
}

/** Fold a chunk's per-reason tally into the run total. */
const accumulate = (into: Record<string, number>, from: Record<string, number> | undefined): void => {
  for (const [reason, n] of Object.entries(from ?? {})) into[reason] = (into[reason] ?? 0) + n;
};

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
    // #299 — row-level containment is only worth having if somebody can see what it contained. These
    // are the run's own totals, which #300 turns into an operator-facing signal. They are counters,
    // NOT failures: a run that dropped a poison row and succeeded on every chunk still finalizes
    // SUCCESS, so the #230 gate lets device-state derivation, auto-recovery and ticket creation run.
    // That is the whole point of the slice — one bad source row must not freeze the fleet's pipeline.
    const rejected: Record<string, number> = {};
    const repaired: Record<string, number> = {};
    // A source read (not a chunk write) throwing mid-scan — e.g. the AutoPlant VPN dropping. This is
    // the path that orphaned run 456: the throw escaped `run()` before `finishRun`, so the run hung
    // RUNNING forever and device-state recompute never ran → empty dashboards. We now catch it, stop
    // draining, and fall through to finalize the run so it can never be left RUNNING.
    let readError: string | null = null;

    try {
      for (;;) {
        const chunk = await this.source.readChunk(cursor, chunkSize);
        accumulate(rejected, chunk.rejected);
        accumulate(repaired, chunk.repaired);

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

        // #261 — one beat per drained chunk. A run that is merely slow keeps saying so and is never
        // reaped for its wall-clock age; a run whose process died stops saying it immediately. Outside
        // any transaction and a single column, so the cost does not scale with the chunk.
        await this.runs.heartbeat(runId);

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

    // #324 (F4) — there used to be a SECOND cursor here: an optimistic re-read floor that dropped
    // back to the first failed chunk's lower bound on a PARTIAL, persisted as `snapshot_runs.cursor`
    // for the next run to resume from. Nothing resumed from it. The production reader restarts from
    // `cursor = null` and keyset-scans every device every run *by design* — "correctness must not
    // depend on a persisted watermark" is its own docblock — so the failed window is re-read anyway,
    // and the floor's only consumer was the test that supplied its own resume-aware reader. Removed
    // rather than labelled: a persisted value with a documented meaning nothing honours reads as a
    // guarantee to the next person, and this one had already been quoted back as if it were true.
    //
    // `dataAsOf` is what remains, and it is the conservative DISPLAY watermark — the high-water of
    // *succeeded* chunks, so the freshness banner never advances over lost data.

    // F10 (#300), recorded here because this is the line the finding was about: `data_as_of` IS
    // written on a PARTIAL run, deliberately. It is the high-water instant of the chunks that landed,
    // and two things read it — integration-health freshness and (since #300) the banner's
    // `partialDataAsOf`, which reports it under its own name. (#324 removed the third, a resume cursor
    // no production reader ever honoured.) What it must never
    // become is the plain "data as of" number: that one stays SUCCESS-only, so a partial read cannot
    // advance the figure an operator reads as covering the whole fleet. FAILED still writes null —
    // nothing landed, so there is no watermark to report at all.
    await this.runs.finishRun(runId, {
      status,
      dataAsOf: status === 'FAILED' ? null : dataAsOf,
      // #300 — persist the containment tallies so a run's rejections stay answerable after the run.
      chunkStats: { rejected, repaired },
    });

    return { runId, status, chunks: chunkNo, succeeded, failed, inserted, rejected, repaired };
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
