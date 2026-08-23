import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { buildStampFields } from '../../build-info/run-stamp';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ORPHANED_RUN_ERROR, staleRunFilter } from '../stale-run';

export type MasterSyncOutcome = 'SUCCESS' | 'FAILED' | 'PARTIAL';

/** Per-entity upsert counters recorded on the run for observability (blueprint §5.7). */
export interface EntityStat {
  inserted: number;
  updated: number;
  skipped: number;
  /** Itemised split of `skipped` per reason code (Issue 97 Slice 4 / review A5). */
  skippedByReason?: Record<string, number>;
  /**
   * Distinct source rows OBSERVED for this entity in the widened read — the raw AutoPlant catalog
   * size, independent of what mirrored/skipped. Populated for `devices` (every fitted `device_id`
   * the sync saw, across all deployment statuses) so the dashboard can show a "Total Devices"
   * (source catalog) count alongside the mirrored operational fleet. Optional: only entities that
   * choose to report it set it.
   */
  observed?: number;
}

/** Thrown (as 409) when a master sync is requested while one is already in flight. */
const runInProgress = (): ConflictException =>
  new ConflictException({
    code: 'RUN_IN_PROGRESS',
    message: 'A master sync run is already in progress',
  });

/**
 * Owns the `master_sync_runs` lifecycle and the single in-flight guard — the master-sync twin of
 * `SnapshotRunService`. Two layers, both mirrored from the snapshot path: a transaction-scoped
 * advisory lock (`pg_try_advisory_xact_lock`) serializes concurrent starts and fails fast; the
 * `WHERE status='RUNNING'` partial-unique index (`master_sync_runs_one_in_flight`, migration
 * 20260703120000) is the durable cross-connection backstop. Either firing surfaces as 409
 * RUN_IN_PROGRESS, so overlapping scheduler ticks never double-sync the org graph.
 */
@Injectable()
export class MasterSyncRunService {
  private readonly logger = new Logger(MasterSyncRunService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reap orphaned RUNNING rows → FAILED, so a process death never permanently locks out future runs
   * (review A2). Runs before the guard is taken; a live RUNNING row is left alone and still 409s.
   * Returns the number reaped.
   *
   * #261 — "orphaned" is decided by {@link staleRunFilter}: a stale *heartbeat*, not an old
   * `started_at`. This sync is the long one, so reaping it for being slow was the real risk here.
   */
  async reapStaleRuns(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.masterSyncRun.updateMany({
      where: { status: 'RUNNING', ...staleRunFilter(now) },
      data: { status: 'FAILED', finishedAt: now, error: ORPHANED_RUN_ERROR },
    });
    return count;
  }

  /** Say the run is still alive (#261) — the twin of `SnapshotRunService.heartbeat`; see it for why. */
  async heartbeat(runId: bigint, now: Date = new Date()): Promise<void> {
    await this.prisma.masterSyncRun.updateMany({
      where: { runId, status: 'RUNNING' },
      data: { heartbeatAt: now },
    });
  }

  async startRun(): Promise<{ runId: bigint }> {
    await this.reapStaleRuns();
    try {
      const run = await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext('master_sync_run')) AS locked`;
        if (!locked[0]?.locked) {
          throw runInProgress();
        }
        // The opening beat — see the twin in `SnapshotRunService.startRun`.
        return tx.masterSyncRun.create({ data: { status: 'RUNNING', heartbeatAt: new Date(), ...buildStampFields() } });
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
   * Close the run — **only if it is still RUNNING** (#261, the defect half of #132). See the twin in
   * `SnapshotRunService.finishRun` for why: a reaped-but-alive run that reports SUCCESS here would
   * overwrite the reaper's FAILED *and* null out `ORPHANED_RUN_ERROR`, erasing the only record of what
   * actually happened to it. First writer wins; a reaped run stays reaped.
   */
  async finishRun(
    runId: bigint,
    params: {
      status: MasterSyncOutcome;
      entityStats?: Record<string, EntityStat> | null;
      error?: string | null;
    },
  ): Promise<void> {
    const { count } = await this.prisma.masterSyncRun.updateMany({
      where: { runId, status: 'RUNNING' },
      data: {
        status: params.status,
        finishedAt: new Date(),
        entityStats: (params.entityStats ?? undefined) as Prisma.InputJsonValue | undefined,
        error: params.error ?? null,
      },
    });
    if (count === 0) {
      this.logger.warn(`master sync run ${runId} finished after being reaped — ${params.status} not recorded`);
    }
  }
}
