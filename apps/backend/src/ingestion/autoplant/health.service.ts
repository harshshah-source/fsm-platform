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

/**
 * Source-side row counts under the SAME filters the master sync reads with (Issue 97 Slice 5 /
 * review A6) — each a single-row `COUNT(*)`, so the DBA `< 100`-row cap is trivially respected.
 * `AutoPlantMasterSource` implements this by reusing its own filter fragments, which is what keeps
 * the reconciliation query from ever diverging from the sync query.
 */
export interface MasterSourceCounts {
  /** Distinct in-scope plants (matches `readPlants`' status filter + plant_id dedup). */
  countPlants(): Promise<number>;
  /** In-scope vehicle-master rows (matches `readVehicleMasters`' deployment filter). */
  countVehicleMasters(): Promise<number>;
}

export interface ReconciliationEntity {
  entity: 'plants' | 'vehicles';
  sourceCount: number;
  fsmCount: number;
  /** `sourceCount - fsmCount` — positive means FSM mirrors less than the source holds. */
  drift: number;
}

export interface ReconciliationHealth {
  entities: ReconciliationEntity[];
  /** All |drift| within threshold; `null` when counts are unavailable (unconfigured / source down). */
  reconciled: boolean | null;
  /** Absolute-row drift tolerated per entity (`INGESTION_RECON_MAX_DRIFT`, default 0). */
  maxDriftAllowed: number;
  error?: string;
}

export interface IntegrationHealth {
  source: IntegrationSourceHealth;
  masterSync: FreshnessHealth;
  snapshot: FreshnessHealth;
  reconciliation: ReconciliationHealth;
  checkedAt: Date;
}

/**
 * Drift tolerance in absolute rows, env-overridable via `INGESTION_RECON_MAX_DRIFT`. Informational
 * ops knob (review risk: drift is expectedly noisy while the zone-mapping queue drains), NOT a
 * business rule; default 0 = report any mismatch.
 */
export function readReconMaxDrift(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.INGESTION_RECON_MAX_DRIFT);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
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
    /** Source-side count reads for reconciliation; null when AutoPlant is unconfigured. */
    private readonly counts: MasterSourceCounts | null = null,
  ) {}

  async check(now: Date = new Date()): Promise<IntegrationHealth> {
    return {
      source: await this.sourceHealth(),
      masterSync: await this.masterSyncHealth(now),
      snapshot: await this.snapshotHealth(now),
      reconciliation: await this.reconciliationHealth(),
      checkedAt: now,
    };
  }

  /**
   * Source-vs-FSM row-count diff per entity (review A6) — the "SUCCESS but mirroring a fraction of
   * the fleet" detector. Degrades to `reconciled: null` + error when counts are unavailable
   * (unconfigured, VPN down): the freshness surfaces above must stay useful regardless.
   */
  private async reconciliationHealth(): Promise<ReconciliationHealth> {
    const maxDriftAllowed = readReconMaxDrift();
    if (!this.counts) {
      return {
        entities: [],
        reconciled: null,
        maxDriftAllowed,
        error: 'source counts unavailable (AutoPlant not configured)',
      };
    }
    try {
      const [sourcePlants, sourceVehicles, fsmPlants, fsmVehicles] = await Promise.all([
        this.counts.countPlants(),
        this.counts.countVehicleMasters(),
        this.prisma.plant.count(),
        this.prisma.vehicle.count(),
      ]);
      const entities: ReconciliationEntity[] = [
        { entity: 'plants', sourceCount: sourcePlants, fsmCount: fsmPlants, drift: sourcePlants - fsmPlants },
        {
          entity: 'vehicles',
          sourceCount: sourceVehicles,
          fsmCount: fsmVehicles,
          drift: sourceVehicles - fsmVehicles,
        },
      ];
      return {
        entities,
        reconciled: entities.every((e) => Math.abs(e.drift) <= maxDriftAllowed),
        maxDriftAllowed,
      };
    } catch (e) {
      return {
        entities: [],
        reconciled: null,
        maxDriftAllowed,
        error: e instanceof Error ? e.message : String(e),
      };
    }
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
