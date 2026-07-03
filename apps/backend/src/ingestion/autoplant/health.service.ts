import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The minimal slice of `AutoPlantMysqlClient` the health surface needs — kept as an interface so the
 * connectivity branches are unit-testable without a live MySQL / VPN. `AutoPlantMysqlClient` satisfies
 * it (`isConfigured()` + `ping()`).
 */
export interface AutoPlantProbe {
  isConfigured(): boolean;
  ping(): Promise<{ ok: true; vehicleRows: number }>;
}

export interface IntegrationSourceHealth {
  /** Two-schema AutoPlant env is set (distinguishes dev/test "unset" from a VPN outage). */
  configured: boolean;
  connected: boolean;
  vehicleRows?: number;
  error?: string;
}

export interface FreshnessHealth {
  /** High-water instant of the last good run (master: `finished_at`; snapshot: `data_as_of`). */
  lastAt: Date | null;
  /** Status of the most recent run of any outcome (RUNNING/SUCCESS/PARTIAL/FAILED). */
  lastStatus: string | null;
  /** Whole minutes between `lastAt` and now; null when there is no good run yet. */
  ageMinutes: number | null;
}

export interface IntegrationHealth {
  source: IntegrationSourceHealth;
  masterSync: FreshnessHealth;
  snapshot: FreshnessHealth;
  checkedAt: Date;
}

/**
 * AutoPlant integration health (blueprint §9) — the Ops-Head observability surface behind
 * `GET /api/integration/health`. Combines source connectivity (config + reachability) with the
 * freshness of the last master-sync and snapshot, derived from the FSM run tables. The freshness
 * paths need no VPN, so this stays useful even while the live source is unreachable — it is exactly
 * how an operator sees "sync stale / source down" without reading logs. Feeds the FAILED/stale banner
 * the dashboard already renders.
 */
@Injectable()
export class AutoPlantHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly source: AutoPlantProbe,
  ) {}

  async check(now: Date = new Date()): Promise<IntegrationHealth> {
    return {
      source: await this.sourceHealth(),
      masterSync: await this.masterSyncHealth(now),
      snapshot: await this.snapshotHealth(now),
      checkedAt: now,
    };
  }

  private async sourceHealth(): Promise<IntegrationSourceHealth> {
    if (!this.source.isConfigured()) {
      return { configured: false, connected: false, error: 'AutoPlant MySQL not configured (env unset)' };
    }
    try {
      const { vehicleRows } = await this.source.ping();
      return { configured: true, connected: true, vehicleRows };
    } catch (e) {
      return { configured: true, connected: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private ageMinutes(from: Date | null, now: Date): number | null {
    if (!from) return null;
    return Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  }

  private async masterSyncHealth(now: Date): Promise<FreshnessHealth> {
    const [latest, lastGood] = await Promise.all([
      this.prisma.masterSyncRun.findFirst({ orderBy: { runId: 'desc' }, select: { status: true } }),
      this.prisma.masterSyncRun.findFirst({
        where: { status: { in: ['SUCCESS', 'PARTIAL'] }, finishedAt: { not: null } },
        orderBy: { runId: 'desc' },
        select: { finishedAt: true },
      }),
    ]);
    const lastAt = lastGood?.finishedAt ?? null;
    return { lastAt, lastStatus: latest?.status ?? null, ageMinutes: this.ageMinutes(lastAt, now) };
  }

  private async snapshotHealth(now: Date): Promise<FreshnessHealth> {
    const [latest, lastGood] = await Promise.all([
      this.prisma.snapshotRun.findFirst({ orderBy: { runId: 'desc' }, select: { status: true } }),
      this.prisma.snapshotRun.findFirst({
        where: { dataAsOf: { not: null } },
        orderBy: { runId: 'desc' },
        select: { dataAsOf: true },
      }),
    ]);
    const lastAt = lastGood?.dataAsOf ?? null;
    return { lastAt, lastStatus: latest?.status ?? null, ageMinutes: this.ageMinutes(lastAt, now) };
  }
}
