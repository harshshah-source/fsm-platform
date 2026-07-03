import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type MasterSyncOutcome = 'SUCCESS' | 'FAILED' | 'PARTIAL';

/** Per-entity upsert counters recorded on the run for observability (blueprint §5.7). */
export interface EntityStat {
  inserted: number;
  updated: number;
  skipped: number;
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
  constructor(private readonly prisma: PrismaService) {}

  async startRun(): Promise<{ runId: bigint }> {
    try {
      const run = await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext('master_sync_run')) AS locked`;
        if (!locked[0]?.locked) {
          throw runInProgress();
        }
        return tx.masterSyncRun.create({ data: { status: 'RUNNING' } });
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

  async finishRun(
    runId: bigint,
    params: {
      status: MasterSyncOutcome;
      entityStats?: Record<string, EntityStat> | null;
      error?: string | null;
    },
  ): Promise<void> {
    await this.prisma.masterSyncRun.update({
      where: { runId },
      data: {
        status: params.status,
        finishedAt: new Date(),
        entityStats: (params.entityStats ?? undefined) as Prisma.InputJsonValue | undefined,
        error: params.error ?? null,
      },
    });
  }
}
