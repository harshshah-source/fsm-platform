import { Injectable } from '@nestjs/common';
import { evaluateRecomputeCanary } from '../../device-state/recompute-canary';
import { PrismaService } from '../../prisma/prisma.service';
import {
  OVERDUE_CADENCE_MULTIPLIER,
  cadenceMinutesOrDefault,
  readIngestionAlert,
  readIngestionStreakThreshold,
  type IngestionAlertHealth,
} from '../ingestion-alert';
import { prismaIngestionAlertSource, readIngestionCadence } from '../snapshot-query.service';
import { readIngestionSchedulerConfig } from './integration-scheduler.service';

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
  /**
   * #348 — the age at which this feed stops being fresh: twice the cadence of the cron that feeds it
   * (`INGESTION_TELEMETRY_CRON` for the snapshot, `INGESTION_MASTERS_CRON` for the master sync).
   *
   * Derived from the configured cron rather than fixed, so widening the schedule widens the threshold
   * with it. Published alongside the verdict so the health page can show the operator what the number
   * was measured against instead of asserting "stale" with no yardstick.
   */
  staleAfterMinutes: number;
  /**
   * #348 — `ageMinutes` is past `staleAfterMinutes`, or there is no good run at all.
   *
   * This is the judgement that did not exist: `ageMinutes` was computed here and then compared with
   * nothing, anywhere, so a 21-hour-old snapshot returned a large number that every surface rendered
   * as an ordinary timestamp. False while the scheduler is deliberately disabled (AC4) — see
   * {@link IntegrationHealth.schedulerEnabled}, which is how the page distinguishes paused from fresh.
   */
  stale: boolean;
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

/**
 * #218 — deployment-lifecycle self-consistency. Deliberately NOT folded into
 * {@link ReconciliationHealth}: that surface compares AutoPlant against FSM and returns
 * `entities: []` the moment the source is unconfigured or the VPN is down. This check is derived
 * entirely inside Postgres, so it must stay readable exactly when the source is unreachable — the
 * same reasoning that keeps the freshness paths VPN-free.
 */
export interface LifecycleHealth {
  /**
   * Devices whose last-observed source status (`vehicles.status`) and derived lifecycle flag
   * (`device_states.is_departed`) contradict each other. Both are written from the same master-sync
   * read, so **the correct value is 0** and any non-zero is a defect by construction — not a
   * tolerance to tune.
   *
   * Devices with an open `ABSENT_FROM_READ` departure are excluded: their row is gone from
   * `mst_vehicle`, so the mirror is frozen at its last-observed value *by design* and cannot agree.
   * They are counted separately as {@link missingFromSource} rather than hidden.
   */
  drift: number;
  /** Departed because their source row vanished. Mirror knowingly stale — excluded from `drift`. */
  missingFromSource: number;
  /**
   * Consecutive most-recent SUCCESS master syncs that recorded neither a departure nor a restore.
   * The fleet churns ~150 vehicles/day, so a sustained run of zeroes means the lifecycle pass is not
   * executing — the exact signal that sat unread in `entity_stats.departures` for 33 runs (#218).
   */
  quietRuns: number;
  /** `quietRuns` exceeds {@link quietRunsThreshold}. */
  quietRunsAlert: boolean;
  quietRunsThreshold: number;
  /** `drift === 0 && !quietRunsAlert` — the whole check in one flag, for the banner. */
  healthy: boolean;
}

export interface IntegrationHealth {
  source: IntegrationSourceHealth;
  masterSync: FreshnessHealth;
  snapshot: FreshnessHealth;
  reconciliation: ReconciliationHealth;
  /** #218 — lifecycle self-consistency; needs no VPN, so it survives a source outage. */
  lifecycle: LifecycleHealth;
  /**
   * #300 — consecutive non-SUCCESS telemetry runs, the chunk that keeps failing, and the downstream
   * stages the #230 gate is skipping. Derived entirely inside Postgres, for the same reason
   * {@link LifecycleHealth} is: a wedged pipeline is exactly the situation in which the source is
   * likely unreachable, and this is the surface that has to keep answering then.
   */
  ingestion: IngestionAlertHealth;
  /** #130 — current build high-water mark, for stale-run comparison in the UI. */
  runtimeLock: RuntimeLockHealth;
  /** #130 L5 — last-N recompute ledger rows (counts + build + swing), newest first. */
  recomputes: RecomputeLedgerEntry[];
  /**
   * #348 — the ingestion scheduler master switch (`INGESTION_SCHEDULER_ENABLED`). False means the
   * crons are dormant by choice, which is why every `stale`/`overdue` flag above is suppressed: the
   * page renders "ingestion paused", never "healthy" and never a false alarm (AC4).
   */
  schedulerEnabled: boolean;
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
 * How many consecutive quiet SUCCESS syncs are tolerated before {@link LifecycleHealth.quietRunsAlert}
 * fires, env-overridable via `INGESTION_LIFECYCLE_QUIET_RUNS`. Default 3: the masters sync runs daily,
 * so three quiet runs is roughly a day of a churning fleet reporting no movement at all — enough to
 * clear an ordinary quiet day, far short of the 27 that went unnoticed. Unlike
 * {@link readReconMaxDrift} this is a *patience* knob, never a tolerance on `drift`, which has no
 * acceptable non-zero value.
 */
export function readLifecycleQuietRuns(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.INGESTION_LIFECYCLE_QUIET_RUNS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
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
    // #348 — one read of the scheduler config for the whole payload, so the two freshness thresholds
    // and the ingestion alert are all judged against the same configured cadence and the same switch.
    const scheduler = readIngestionSchedulerConfig();
    return {
      source: await this.sourceHealth(),
      masterSync: await this.masterSyncHealth(now, lockVersion, scheduler.mastersCron, scheduler.enabled),
      snapshot: await this.snapshotHealth(now, lockVersion, scheduler.telemetryCron, scheduler.enabled),
      reconciliation: await this.reconciliationHealth(),
      lifecycle: await this.lifecycleHealth(),
      ingestion: await this.ingestionHealth(now),
      runtimeLock: lock,
      recomputes: await this.recomputeHistory(lockVersion),
      schedulerEnabled: scheduler.enabled,
      checkedAt: now,
    };
  }

  /**
   * #348 — the freshness verdict, in one place for both feeds.
   *
   * `ageMinutes` existed here from the start and was compared with nothing; this is that missing
   * comparison. Threshold = twice the feed's own cron cadence (see {@link FreshnessHealth.staleAfterMinutes}).
   * No good run at all counts as stale — "never" is not "recent". Suppressed entirely while the
   * scheduler is off, so a deliberately-paused pipeline never renders as a fault (AC4).
   */
  private freshnessVerdict(
    ageMinutes: number | null,
    cron: string,
    schedulerEnabled: boolean,
  ): { staleAfterMinutes: number; stale: boolean } {
    const staleAfterMinutes = cadenceMinutesOrDefault(cron) * OVERDUE_CADENCE_MULTIPLIER;
    return {
      staleAfterMinutes,
      stale: schedulerEnabled && (ageMinutes === null || ageMinutes > staleAfterMinutes),
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
   *
   * **Public** so the Operations Data Explorer's reconciliation panel (#217 S3) can fold these same
   * counts in as two more identities, without a second AutoPlant COUNT(*) implementation — reused,
   * not respelled, same as `dashboard.service.ts`'s `FLEET_COUNT_COLUMNS` is for the device identities.
   */
  async reconciliationHealth(): Promise<ReconciliationHealth> {
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

  /**
   * #218 — the lifecycle contradiction check. `vehicles.status` (verbatim last-observed source
   * status) and `device_states.is_departed` (derived from the `device_departures` ledger) are both
   * written from the same master-sync read, so they cannot legitimately disagree. When the lifecycle
   * pass stops running they drift apart silently: every dashboard identity still balances, because
   * both the operational and warehouse counts move together — only a comparison BETWEEN the two
   * sources of truth catches it.
   *
   * `quietRuns` covers the same failure from the other side: the pass reporting that it did nothing,
   * run after run, which is what `entity_stats.departures` recorded 33 times while nothing read it.
   *
   * Raw SQL for the same reason `runtimeLock` uses it — `<>` over two boolean expressions and the
   * `entity_stats` JSON path have no Prisma-query equivalent. Constant statements, no interpolation.
   *
   * **Public** for the same reason {@link reconciliationHealth} is: the Operations Data Explorer
   * folds this in as another identity without a second implementation of the predicate — reused, not
   * respelled, so the two surfaces cannot drift apart and report different answers.
   */
  async lifecycleHealth(): Promise<LifecycleHealth> {
    const quietRunsThreshold = readLifecycleQuietRuns();

    const [counts] = await this.prisma.$queryRawUnsafe<Array<{ drift: number; missingFromSource: number }>>(
      `SELECT
         (SELECT COUNT(*) FROM device_states ds
            JOIN vehicles v ON v.vehicle_id = ds.vehicle_id
           WHERE (v.status IN ('DEPLOYED', 'ACTIVE')) <> (ds.is_departed = false)
             AND NOT EXISTS (SELECT 1 FROM device_departures dd
                              WHERE dd.device_id = ds.device_id
                                AND dd.restored_at IS NULL
                                AND dd.reason = 'ABSENT_FROM_READ'))::int AS "drift",
         (SELECT COUNT(*) FROM device_departures
           WHERE restored_at IS NULL AND reason = 'ABSENT_FROM_READ')::int AS "missingFromSource"`,
    );

    // Runs newer than the most recent one that actually moved a device either way. No such run ⇒
    // every SUCCESS run has been quiet, which is the state this check exists to catch.
    const [quiet] = await this.prisma.$queryRawUnsafe<Array<{ quietRuns: number }>>(
      `WITH recent AS (
         SELECT entity_stats, ROW_NUMBER() OVER (ORDER BY run_id DESC) AS rn
           FROM master_sync_runs WHERE status = 'SUCCESS')
       SELECT COUNT(*)::int AS "quietRuns" FROM recent
        WHERE rn < COALESCE(
                (SELECT MIN(rn) FROM recent
                  WHERE COALESCE((entity_stats -> 'departures' ->> 'inserted')::int, 0) <> 0
                     OR COALESCE((entity_stats -> 'departures' ->> 'updated')::int, 0) <> 0),
                (SELECT COUNT(*) + 1 FROM recent))`,
    );

    const drift = counts?.drift ?? 0;
    const quietRuns = quiet?.quietRuns ?? 0;
    const quietRunsAlert = quietRuns > quietRunsThreshold;
    return {
      drift,
      missingFromSource: counts?.missingFromSource ?? 0,
      quietRuns,
      quietRunsAlert,
      quietRunsThreshold,
      healthy: drift === 0 && !quietRunsAlert,
    };
  }

  /**
   * #300 — the wedged-ingestion alert. Reads the SAME source the freshness banner's copy reads
   * (`prismaIngestionAlertSource`), so the OH card and the every-page banner cannot report different
   * verdicts about whether the pipeline is stuck. Read-only; no VPN.
   *
   * **Public** for the same reason {@link lifecycleHealth} is — one predicate, reused rather than
   * respelled by whatever surface needs it next.
   */
  async ingestionHealth(now: Date = new Date()): Promise<IngestionAlertHealth> {
    return readIngestionAlert(
      prismaIngestionAlertSource(this.prisma),
      readIngestionStreakThreshold(),
      // #348 — the SAME cadence resolution the banner feed uses, for the same reason the source is
      // shared: one derivation, two surfaces, no way for them to disagree about whether it is silent.
      readIngestionCadence(now),
    );
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

  private async masterSyncHealth(
    now: Date,
    lockVersion: number | null,
    cron: string,
    schedulerEnabled: boolean,
  ): Promise<FreshnessHealth> {
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
    const ageMinutes = this.ageMinutes(lastAt, now);
    return {
      lastAt,
      lastStatus: latest?.status ?? null,
      ageMinutes,
      ...this.freshnessVerdict(ageMinutes, cron, schedulerEnabled),
      build: latest ? this.buildStamp(latest.buildVersion, latest.buildFingerprint, lockVersion) : null,
    };
  }

  private async snapshotHealth(
    now: Date,
    lockVersion: number | null,
    cron: string,
    schedulerEnabled: boolean,
  ): Promise<FreshnessHealth> {
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
    const ageMinutes = this.ageMinutes(lastAt, now);
    return {
      lastAt,
      lastStatus: latest?.status ?? null,
      ageMinutes,
      ...this.freshnessVerdict(ageMinutes, cron, schedulerEnabled),
      build: latest ? this.buildStamp(latest.buildVersion, latest.buildFingerprint, lockVersion) : null,
    };
  }
}
