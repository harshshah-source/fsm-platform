import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { buildStampFields } from '../build-info/run-stamp';
import { PrismaService } from '../prisma/prisma.service';
import { staleRunFilter } from './stale-run';

export type SnapshotRunOutcome = 'SUCCESS' | 'FAILED' | 'PARTIAL';

/** Thrown (as 409) when a snapshot run is requested while one is already in flight. */
const runInProgress = (): ConflictException =>
  new ConflictException({
    code: 'RUN_IN_PROGRESS',
    message: 'A snapshot run is already in progress',
  });

/**
 * Owns the `snapshot_runs` lifecycle and the single in-flight guard.
 *
 * Two layers, both from the LLD: a transaction-scoped advisory lock
 * (`pg_try_advisory_xact_lock`) serializes concurrent starts and fails fast; the
 * `WHERE status='RUNNING'` partial-unique index (slice 1) is the durable backstop that rejects a
 * second RUNNING row even across processes/connections. Either firing surfaces as 409
 * RUN_IN_PROGRESS, which `POST /api/snapshots/run` returns verbatim (slice 7).
 */
@Injectable()
export class SnapshotRunService {
  private readonly logger = new Logger(SnapshotRunService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reap orphaned RUNNING rows → FAILED, so a process death never permanently locks out future runs
   * (review A2). `snapshot_runs` has no `error` column, so the status flip + `finished_at` are the
   * record. Runs before the guard is taken; a live RUNNING row still 409s. Supersedes the CLI-only
   * `deleteMany({status:'RUNNING'})` workaround.
   *
   * #261 — "orphaned" is now decided by {@link staleRunFilter}: a stale *heartbeat*, not an old
   * `started_at`. A slow run that is still beating is alive and is left alone.
   */
  async reapStaleRuns(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.snapshotRun.updateMany({
      where: { status: 'RUNNING', ...staleRunFilter(now) },
      data: { status: 'FAILED', finishedAt: now },
    });
    return count;
  }

  /**
   * Say the run is still alive (#261). Called at each pipeline stage boundary — a single-column write
   * outside any long transaction, which is what makes it affordable often enough to be meaningful.
   *
   * Scoped to `status = 'RUNNING'`: a beat cannot un-reap a run (the reaper only looks at RUNNING
   * rows), but stamping a fresh beat onto a row somebody already closed would make a dead run read as
   * a live one to the next human who looks.
   */
  async heartbeat(runId: bigint, now: Date = new Date()): Promise<void> {
    await this.prisma.snapshotRun.updateMany({
      where: { runId, status: 'RUNNING' },
      data: { heartbeatAt: now },
    });
  }

  async startRun(): Promise<{ runId: bigint }> {
    await this.reapStaleRuns();
    try {
      const run = await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext('snapshot_run')) AS locked`;
        if (!locked[0]?.locked) {
          throw runInProgress();
        }
        // The opening beat: without it the row is born already NULL-hearted, and the reaper would fall
        // back to `started_at` for the whole of its first window.
        return tx.snapshotRun.create({ data: { status: 'RUNNING', heartbeatAt: new Date(), ...buildStampFields() } });
      });
      return { runId: run.runId };
    } catch (e) {
      // Partial-unique backstop: a concurrent/sequential RUNNING insert violates the guard index.
      if ((e as { code?: string }).code === 'P2002') {
        throw runInProgress();
      }
      throw e;
    }
  }

  /**
   * #324 (F4) — there is deliberately **no `lastResumeCursor` here any more**, and nothing writes
   * `snapshot_runs.cursor`.
   *
   * It read the newest SUCCESS/PARTIAL run's persisted cursor so `AutoPlantSourceReader` could resume
   * across runs (blueprint §6.2 option a). That reader was then built the other way on purpose — see
   * its own docblock: *"There is deliberately NO cross-run resume cursor: correctness must not depend
   * on a persisted watermark."* It restarts from `cursor = null` and keyset-scans every device by
   * `device_id` on every run, so the whole window a resume floor protects is re-read regardless, and
   * `ON CONFLICT DO NOTHING` on `(device_id, gps_datetime)` makes the overlap free.
   *
   * What was left was worse than dead code: a persisted value with a documented meaning that no
   * production path honoured, so anyone reading `snapshot_runs.cursor` — or this method — would have
   * concluded the pipeline was incremental when it is not. The only caller was a test that supplied
   * its own resume-aware reader, i.e. the machinery's only consumer was its own test.
   *
   * The **column stays** (`schema.prisma`): dropping it needs a migration, it is nullable, and old rows
   * are honest history of a design that once did this. It simply stops being written.
   */

  /**
   * Close the run — **only if it is still RUNNING** (#261, the defect half of #132).
   *
   * The reaper above exists because a dead process orphans a RUNNING row. But a run slow enough to be
   * reaped is not always dead: it can wake up, finish its work and call this. An unconditional update
   * then overwrites the reaper's FAILED with SUCCESS and advances `data_as_of` — a ledger claiming a
   * successful run that nothing was tracking any more, and a watermark moved by a run nobody trusted.
   * Conditioning on `status = 'RUNNING'` makes the first writer win, so a reaped run stays reaped.
   */
  async finishRun(
    runId: bigint,
    params: {
      status: SnapshotRunOutcome;
      dataAsOf?: Date | null;
      /**
       * #300 — the run's own #299 containment tallies (`{ rejected, repaired }`), parked in the
       * already-existing (and until now unwritten) `chunk_stats` JSONB column.
       *
       * #299 left these riding `SnapshotRunResult` and a WARN log only, so a run's rejections were
       * un-queryable the moment the process moved on — which makes them useless to the operator
       * surface #300 exists to build. This is diagnostic bookkeeping on the row the run already
       * writes: it adds no column, no migration, and no input to the SUCCESS/PARTIAL/FAILED verdict
       * or the #230 gate, which are computed exactly as before and passed in unchanged.
       */
      chunkStats?: { rejected: Record<string, number>; repaired: Record<string, number> } | null;
    },
  ): Promise<void> {
    const { count } = await this.prisma.snapshotRun.updateMany({
      where: { runId, status: 'RUNNING' },
      data: {
        status: params.status,
        finishedAt: new Date(),
        dataAsOf: params.dataAsOf ?? null,
        ...(params.chunkStats ? { chunkStats: params.chunkStats } : {}),
      },
    });
    if (count === 0) {
      this.logger.warn(`snapshot run ${runId} finished after being reaped — ${params.status} not recorded`);
    }
  }
}
