import { Injectable } from '@nestjs/common';
import { type SnapshotStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import {
  readIngestionAlert,
  readIngestionStreakThreshold,
  type IngestionAlertHealth,
  type IngestionAlertSource,
} from './ingestion-alert';

export interface SnapshotRunView {
  runId: string;
  status: SnapshotStatus;
  startedAt: string;
  finishedAt: string | null;
  dataAsOf: string | null;
}

export interface SnapshotLatestView {
  /** Freshness shown by the data-as-of banner — from the last SUCCESS run. */
  dataAsOf: string | null;
  lastSuccessAt: string | null;
  /** The most recent run of any status — drives the red alert on FAILED/stuck (slice 8). */
  latest: SnapshotRunView | null;
  /**
   * #300 / F10 — the newest PARTIAL run's `data_as_of`, when it is ahead of {@link dataAsOf}; null
   * otherwise.
   *
   * This settles the F10 disagreement rather than papering over it. The worker deliberately persists
   * `data_as_of` on a PARTIAL run (`snapshot-ingestion.worker.ts`): it is the high-water instant of the
   * chunks that DID land, and both the resume cursor and the integration-health freshness read it. The
   * banner, meanwhile, read only the last SUCCESS — so the two components disagreed about what the
   * value meant, and one of them threw it away.
   *
   * The recorded decision is: the PARTIAL watermark is real and is REPORTED, but it is reported under
   * its own name ("partial data through …") and never as {@link dataAsOf}. A partial read must never
   * be able to advance the number an operator reads as "the fleet, as of". Both components now agree:
   * the value exists, it means "some devices are covered to here", and it is labelled as such.
   */
  partialDataAsOf: string | null;
  /**
   * #300 — the wedged-pipeline state behind the banner, so a gated pipeline cannot render as healthy
   * (AC2). Same derivation the OH integration-health card renders, so the two cannot disagree.
   */
  ingestion: IngestionAlertHealth;
}

const STATUSES: SnapshotStatus[] = ['RUNNING', 'SUCCESS', 'FAILED', 'PARTIAL'];

type RunRow = {
  runId: bigint;
  status: SnapshotStatus;
  startedAt: Date;
  finishedAt: Date | null;
  dataAsOf: Date | null;
};

const toView = (r: RunRow): SnapshotRunView => ({
  runId: r.runId.toString(),
  status: r.status,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
  dataAsOf: r.dataAsOf?.toISOString() ?? null,
});

/**
 * The `snapshot_runs`/`snapshot_run_chunks` reads behind #300's alert derivation, as a Prisma-backed
 * {@link IngestionAlertSource}.
 *
 * **Exported** so `AutoPlantHealthService` renders the OH card off the same two queries the banner
 * uses — one derivation, two surfaces, no way for them to report different verdicts. RUNNING rows are
 * excluded here, not in the derivation: an in-flight run is not yet an outcome, and letting one reset
 * the streak would hide a wedge behind the very retry that keeps failing.
 */
export function prismaIngestionAlertSource(prisma: PrismaService): IngestionAlertSource {
  return {
    findFinalizedRuns: (limit) =>
      prisma.snapshotRun.findMany({
        where: { status: { not: 'RUNNING' } },
        orderBy: { runId: 'desc' },
        take: limit,
        select: { runId: true, status: true, chunkStats: true },
      }),
    findFailedChunks: (runIds) =>
      prisma.snapshotRunChunk.findMany({
        where: { runId: { in: runIds }, status: 'FAILED' },
        orderBy: [{ runId: 'desc' }, { chunkNo: 'asc' }],
        select: { runId: true, chunkNo: true, retryCount: true, error: true },
      }),
  };
}

/** Read side of snapshot ingestion — the banner feed and the run history. */
@Injectable()
export class SnapshotQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async latest(): Promise<SnapshotLatestView> {
    const [lastSuccess, latest, lastPartial, ingestion] = await Promise.all([
      this.prisma.snapshotRun.findFirst({
        where: { status: 'SUCCESS' },
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.snapshotRun.findFirst({ orderBy: { startedAt: 'desc' } }),
      this.prisma.snapshotRun.findFirst({
        where: { status: 'PARTIAL', dataAsOf: { not: null } },
        orderBy: { runId: 'desc' },
        select: { dataAsOf: true },
      }),
      readIngestionAlert(prismaIngestionAlertSource(this.prisma), readIngestionStreakThreshold()),
    ]);

    const dataAsOf = lastSuccess?.dataAsOf ?? null;
    // Only ahead-of-SUCCESS partial coverage is worth saying out loud; an older PARTIAL watermark tells
    // the operator nothing the SUCCESS line does not already cover.
    const partialDataAsOf =
      lastPartial?.dataAsOf && (dataAsOf === null || lastPartial.dataAsOf > dataAsOf) ? lastPartial.dataAsOf : null;

    return {
      dataAsOf: dataAsOf?.toISOString() ?? null,
      lastSuccessAt: lastSuccess?.finishedAt?.toISOString() ?? null,
      latest: latest ? toView(latest) : null,
      partialDataAsOf: partialDataAsOf?.toISOString() ?? null,
      ingestion,
    };
  }

  async listRuns(
    opts: { limit?: number; offset?: number; status?: string } = {},
  ): Promise<SnapshotRunView[]> {
    const limit = Math.min(opts.limit && opts.limit > 0 ? opts.limit : 50, 200);
    const offset = opts.offset && opts.offset > 0 ? opts.offset : 0;
    const status =
      opts.status && (STATUSES as string[]).includes(opts.status)
        ? (opts.status as SnapshotStatus)
        : undefined;

    const runs = await this.prisma.snapshotRun.findMany({
      where: status ? { status } : undefined,
      orderBy: { startedAt: 'desc' },
      take: limit,
      skip: offset,
    });
    return runs.map(toView);
  }
}
