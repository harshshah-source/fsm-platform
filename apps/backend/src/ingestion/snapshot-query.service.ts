import { Injectable } from '@nestjs/common';
import { type SnapshotStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { readIngestionSchedulerConfig } from './autoplant/integration-scheduler.service';
import {
  cadenceMinutesOrDefault,
  readIngestionAlert,
  readIngestionStreakThreshold,
  type IngestionAlertHealth,
  type IngestionAlertSource,
  type IngestionCadence,
} from './ingestion-alert';

export interface SnapshotRunView {
  runId: string;
  status: SnapshotStatus;
  startedAt: string;
  finishedAt: string | null;
  dataAsOf: string | null;
  /**
   * #348 — why the run ended, when it recorded a reason. `ORPHANED_RUN_ERROR` for a run the heartbeat
   * reaper closed; null for everything written before the column existed, and for runs that ended
   * without one. Surfaced on the OH run history so a process restart is distinguishable from a real
   * ingestion failure.
   */
  error: string | null;
}

/**
 * #348 — the scheduler's configured cadence + master switch, as the silence rule needs them.
 *
 * Resolved HERE rather than inside `ingestion-alert.ts` so that module stays free of `process.env`
 * and of the Nest graph, and read from `readIngestionSchedulerConfig` rather than re-spelled so the
 * freshness threshold can never disagree with the cron the scheduler actually registered — a
 * threshold that does not move with its cadence is the exact failure #348 exists to fix.
 */
export function readIngestionCadence(now: Date = new Date()): IngestionCadence {
  const config = readIngestionSchedulerConfig();
  return {
    expectedCadenceMinutes: cadenceMinutesOrDefault(config.telemetryCron),
    schedulerEnabled: config.enabled,
    now,
  };
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
  /**
   * #348 — ingestion has gone SILENT: no SUCCESS run inside twice the configured cadence, while the
   * scheduler is supposed to be running. Lifted to the top level next to `dataAsOf` because it is a
   * verdict about *this timestamp*, not a detail of the wedge state — the banner must be able to
   * decide "do not present this as freshness" without reading into `ingestion`.
   *
   * False while {@link schedulerPaused}: a switched-off scheduler is not overdue (AC4).
   */
  overdue: boolean;
  /** #348 — the scheduler is deliberately disabled; the banner says "paused", never "healthy" (AC4). */
  schedulerPaused: boolean;
}

const STATUSES: SnapshotStatus[] = ['RUNNING', 'SUCCESS', 'FAILED', 'PARTIAL'];

type RunRow = {
  runId: bigint;
  status: SnapshotStatus;
  startedAt: Date;
  finishedAt: Date | null;
  dataAsOf: Date | null;
  error?: string | null;
};

const toView = (r: RunRow): SnapshotRunView => ({
  runId: r.runId.toString(),
  status: r.status,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
  dataAsOf: r.dataAsOf?.toISOString() ?? null,
  error: r.error ?? null,
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
        // #348 — `startedAt`/`finishedAt` ride along so the silence rule measures the newest SUCCESS's
        // age from THIS window instead of paying a second query on a path polled every 60 seconds.
        select: { runId: true, status: true, chunkStats: true, startedAt: true, finishedAt: true },
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

  async latest(now: Date = new Date()): Promise<SnapshotLatestView> {
    const cadence = readIngestionCadence(now);
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
      readIngestionAlert(prismaIngestionAlertSource(this.prisma), readIngestionStreakThreshold(), cadence),
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
      overdue: ingestion.overdue,
      schedulerPaused: ingestion.schedulerPaused,
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
