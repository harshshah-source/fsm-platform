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
   * The last SUCCESS/PARTIAL run's persisted cursor (its `data_as_of`, a UTC instant), or null when no
   * prior run has ingested data. The `AutoPlantSourceReader` resumes from this across runs (blueprint
   * §6.2 option a) — keeps the worker generic while making ingestion incremental (R10).
   */
  async lastResumeCursor(): Promise<string | null> {
    const last = await this.prisma.snapshotRun.findFirst({
      where: { status: { in: ['SUCCESS', 'PARTIAL'] }, cursor: { not: null } },
      orderBy: { runId: 'desc' },
      select: { cursor: true },
    });
    return last?.cursor ?? null;
  }

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
      cursor?: string | null;
    },
  ): Promise<void> {
    const { count } = await this.prisma.snapshotRun.updateMany({
      where: { runId, status: 'RUNNING' },
      data: {
        status: params.status,
        finishedAt: new Date(),
        dataAsOf: params.dataAsOf ?? null,
        cursor: params.cursor,
      },
    });
    if (count === 0) {
      this.logger.warn(`snapshot run ${runId} finished after being reaped — ${params.status} not recorded`);
    }
  }
}
