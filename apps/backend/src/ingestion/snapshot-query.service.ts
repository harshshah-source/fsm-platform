import { Injectable } from '@nestjs/common';
import { type SnapshotStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

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

/** Read side of snapshot ingestion — the banner feed and the run history. */
@Injectable()
export class SnapshotQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async latest(): Promise<SnapshotLatestView> {
    const [lastSuccess, latest] = await Promise.all([
      this.prisma.snapshotRun.findFirst({
        where: { status: 'SUCCESS' },
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.snapshotRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    ]);
    return {
      dataAsOf: lastSuccess?.dataAsOf?.toISOString() ?? null,
      lastSuccessAt: lastSuccess?.finishedAt?.toISOString() ?? null,
      latest: latest ? toView(latest) : null,
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
