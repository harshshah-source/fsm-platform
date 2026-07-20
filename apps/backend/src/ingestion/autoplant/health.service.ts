import { Injectable } from '@nestjs/common';
import { evaluateRecomputeCanary } from '../../device-state/recompute-canary';
import { PrismaService } from '../../prisma/prisma.service';

/** How many recent recompute-ledger rows the health surface returns (#130 L5). */
const RECOMPUTE_HISTORY_LIMIT = 10;
const DEFAULT_CANARY_THRESHOLD_PCT = 5;

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

/** #130 L3 — the build that produced a run, and whether it is below the current lock high-water mark. */
export interface RunBuildStamp {
  /** BigInt serialized as a string (no BigInt in the JSON payload). */
  buildVersion: string | null;
  buildFingerprint: string | null;
  /** True when this run's build_version is below the current runtime_lock version (a stale-build run). */
  staleBuild: boolean;
}

export interface FreshnessHealth {
  /** High-water instant of the last good run (master: `finished_at`; snapshot: `data_as_of`). */
  lastAt: Date | null;
  /** Status of the most recent run of any outcome (RUNNING/SUCCESS/PARTIAL/FAILED). */
  lastStatus: string | null;
  /** Whole minutes between `lastAt` and now; null when there is no good run yet. */
  ageMinutes: number | null;
  /** #130 L3 — build attribution of the most recent run (null when it predates stamping). */
  build: RunBuildStamp | null;
}

/** #130 — the database's current build high-water mark, for the FE to render "current build vX". */
export interface RuntimeLockHealth {
  version: string | null;
  fingerprint: string | null;
}

/** #130 L5 — one recompute-ledger row for the health history, with the canary swing flag resolved. */
export interface RecomputeLedgerEntry {
  recomputeId: string;
  computedAt: Date;
  eligibleCount: number;
  inactiveCount: number;
  departedCount: number;
  totalCount: number;
  buildVersion: string | null;
  buildFingerprint: string | null;
  trigger: string;
  /** Build below the current lock — this recompute ran under a stale build. */
  staleBuild: boolean;
  /** Relative eligible swing vs the previous (older) row; null for the oldest row in the window. */
  swingPct: number | null;
  /** True when |swingPct| exceeds the canary threshold — the row the operator should investigate. */
  swing: boolean;
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
  /** #130 — current build high-water mark, for stale-run comparison in the UI. */
  runtimeLock: RuntimeLockHealth;
  /** #130 L5 — last-N recompute ledger rows (counts + build + swing), newest first. */
  recomputes: RecomputeLedgerEntry[];
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
    // #130 — the lock version is the reference for every stale-build comparison below.
    const lock = await this.runtimeLock();
    const lockVersion = lock.version != null ? Number(lock.version) : null;
    return {
      source: await this.sourceHealth(),
      masterSync: await this.masterSyncHealth(now, lockVersion),
      snapshot: await this.snapshotHealth(now, lockVersion),
      reconciliation: await this.reconciliationHealth(),
      runtimeLock: lock,
      recomputes: await this.recomputeHistory(lockVersion),
      checkedAt: now,
    };
  }

  /** #130 — the database's current build high-water mark (raw: runtime_lock is not a Prisma model). */
  private async runtimeLock(): Promise<RuntimeLockHealth> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ version: string | null; fingerprint: string | null }>>(
      `SELECT version::text AS version, fingerprint FROM runtime_lock WHERE id = 1`,
    );
    return { version: rows[0]?.version ?? null, fingerprint: rows[0]?.fingerprint ?? null };
  }

  /** #130 L3 — a run's build stamp + whether it is below the lock high-water mark. */
  private buildStamp(
    buildVersion: bigint | null,
    buildFingerprint: string | null,
    lockVersion: number | null,
  ): RunBuildStamp {
    return {
      buildVersion: buildVersion != null ? buildVersion.toString() : null,
      buildFingerprint: buildFingerprint ?? null,
      staleBuild: buildVersion != null && lockVersion != null && Number(buildVersion) < lockVersion,
    };
  }

  /**
   * #130 L5 — last-N recompute ledger rows (newest first), each with the canary swing flag resolved
   * against its immediately-older neighbour and a staleBuild flag against the lock. This is the
   * attribution + swing history the integration-health page renders.
   */
  private async recomputeHistory(lockVersion: number | null): Promise<RecomputeLedgerEntry[]> {
    const thresholdPct =
      (await this.prisma.systemSetting
        .findUnique({ where: { key: 'recompute_canary_threshold_pct' } })
        .then((s) => (typeof s?.value === 'number' ? s.value : undefined))) ?? DEFAULT_CANARY_THRESHOLD_PCT;

    const rows = await this.prisma.deviceStateRecompute.findMany({
      orderBy: { computedAt: 'desc' },
      take: RECOMPUTE_HISTORY_LIMIT,
    });

    return rows.map((row, i) => {
      // The previous (older) row in the window is the next index (rows are newest-first).
      const previous = rows[i + 1];
      const verdict = previous ? evaluateRecomputeCanary(previous.eligibleCount, row.eligibleCount, thresholdPct) : null;
      return {
        recomputeId: row.recomputeId.toString(),
        computedAt: row.computedAt,
        eligibleCount: row.eligibleCount,
        inactiveCount: row.inactiveCount,
        departedCount: row.departedCount,
        totalCount: row.totalCount,
        buildVersion: row.buildVersion != null ? row.buildVersion.toString() : null,
        buildFingerprint: row.buildFingerprint ?? null,
        trigger: row.trigger,
        staleBuild: row.buildVersion != null && lockVersion != null && Number(row.buildVersion) < lockVersion,
        swingPct: verdict ? verdict.deltaPct : null,
        swing: verdict?.breached ?? false,
      };
    });
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

  private async masterSyncHealth(now: Date, lockVersion: number | null): Promise<FreshnessHealth> {
    const [latest, lastGood] = await Promise.all([
      this.prisma.masterSyncRun.findFirst({
        orderBy: { runId: 'desc' },
        select: { status: true, buildVersion: true, buildFingerprint: true },
      }),
      this.prisma.masterSyncRun.findFirst({
        where: { status: { in: ['SUCCESS', 'PARTIAL'] }, finishedAt: { not: null } },
        orderBy: { runId: 'desc' },
        select: { finishedAt: true },
      }),
    ]);
    const lastAt = lastGood?.finishedAt ?? null;
    return {
      lastAt,
      lastStatus: latest?.status ?? null,
      ageMinutes: this.ageMinutes(lastAt, now),
      build: latest ? this.buildStamp(latest.buildVersion, latest.buildFingerprint, lockVersion) : null,
    };
  }

  private async snapshotHealth(now: Date, lockVersion: number | null): Promise<FreshnessHealth> {
    const [latest, lastGood] = await Promise.all([
      this.prisma.snapshotRun.findFirst({
        orderBy: { runId: 'desc' },
        select: { status: true, buildVersion: true, buildFingerprint: true },
      }),
      this.prisma.snapshotRun.findFirst({
        where: { dataAsOf: { not: null } },
        orderBy: { runId: 'desc' },
        select: { dataAsOf: true },
      }),
    ]);
    const lastAt = lastGood?.dataAsOf ?? null;
    return {
      lastAt,
      lastStatus: latest?.status ?? null,
      ageMinutes: this.ageMinutes(lastAt, now),
      build: latest ? this.buildStamp(latest.buildVersion, latest.buildFingerprint, lockVersion) : null,
    };
  }
}
