import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

  async startRun(): Promise<{ runId: bigint }> {
    try {
      const run = await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext('snapshot_run')) AS locked`;
        if (!locked[0]?.locked) {
          throw runInProgress();
        }
        return tx.snapshotRun.create({ data: { status: 'RUNNING' } });
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

  async finishRun(
    runId: bigint,
    params: {
      status: SnapshotRunOutcome;
      dataAsOf?: Date | null;
      cursor?: string | null;
    },
  ): Promise<void> {
    await this.prisma.snapshotRun.update({
      where: { runId },
      data: {
        status: params.status,
        finishedAt: new Date(),
        dataAsOf: params.dataAsOf ?? null,
        cursor: params.cursor,
      },
    });
  }
}
