import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CronTickClaimService } from '../scheduling/cron-tick-claim.service';
import { SettingsService } from '../settings/settings.service';
import {
  planPartitionMaintenance,
  resolveRetentionDays,
  TELEMETRY_RETENTION_DAYS_KEY,
  type MaintenancePlan,
} from './partition-planner';

/** #263 — the registered cron-job name, shared by the decorator and the tick claim. */
export const PARTITION_MAINTENANCE_JOB_NAME = 'partition-maintenance';

/** UTC days of partitions to keep ahead of today so ingestion never falls back to the DEFAULT catch-all. */
const CREATE_AHEAD_DAYS = 3;

/** Generated partition names must match this before ever reaching DDL — defence against interpolation. */
const SAFE_NAME_RE = /^raw_device_snapshots_y\d{4}m\d{2}d\d{2}$/;

/**
 * What the daily tick reports. It used to return `void`; #263 gave it the same structured outcome the
 * other schedulers carry, because "another instance owns this window" is a third state that a `void`
 * return cannot express and an operator cannot otherwise distinguish from "the flag is off".
 */
export type MaintenanceTickOutcome = { ran: true } | { ran: false; reason: 'DISABLED' | 'TICK_CLAIMED' | 'ERROR' };

export interface MaintenanceResult {
  retentionDays: number;
  created: string[];
  dropped: string[];
}

/**
 * Daily maintenance for the range-partitioned `raw_device_snapshots` telemetry table (R3): create the
 * next few days' partitions ahead of time and drop partitions older than the configured retention window.
 *
 * The retention window is an operational value read from `system_settings.telemetry_retention_days`,
 * defaulting to 7 days when unset — Ops can change it at any time with no redeploy (see
 * {@link resolveRetentionDays}). The DECISION (which to create/drop) is the pure
 * {@link planPartitionMaintenance}; this service only reads the live partition list and executes the DDL.
 *
 * `DROP TABLE` on a partition detaches and removes it in one step — retention is O(1) per day, not a
 * DELETE storm. The DEFAULT partition is never dropped (it has no dated name and the planner skips it),
 * and every name is re-validated against a strict pattern before interpolation.
 */
@Injectable()
export class PartitionMaintenanceService {
  private readonly logger = new Logger(PartitionMaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    // The concrete service rather than the `TickClaimant`/`TickClaimPruner` ports the other six
    // schedulers take: this one is plain-DI (no factory), and Nest resolves a constructor param by its
    // emitted class token — a structural type would leave nothing to inject.
    private readonly claims: CronTickClaimService,
  ) {}

  /**
   * Daily create-ahead + retention tick. Opt-in via `PARTITION_MAINTENANCE_ENABLED=true` (default OFF —
   * enabling is an ops step, same posture as the ingestion scheduler); a failure is logged, never thrown
   * out of the cron context. The cron expression is env-overridable (`PARTITION_MAINTENANCE_CRON`).
   */
  @Cron(process.env.PARTITION_MAINTENANCE_CRON?.trim() || '10 0 * * *', { name: PARTITION_MAINTENANCE_JOB_NAME })
  async scheduledMaintenance(firedAt: Date = new Date()): Promise<MaintenanceTickOutcome> {
    if (process.env.PARTITION_MAINTENANCE_ENABLED !== 'true') return { ran: false, reason: 'DISABLED' };
    try {
      if (!(await this.claims.claimTickOrLog(PARTITION_MAINTENANCE_JOB_NAME, firedAt))) {
        return { ran: false, reason: 'TICK_CLAIMED' };
      }
      await this.runMaintenance(firedAt);
      // #263 AC-4 — the claim table's retention rides here rather than on a cron of its own. A
      // nineteenth job would have to be added to `scheduler-wiring.e2e-spec.ts`, and that list is a
      // decision record: a table of a few thousand rows a week does not justify an entry in it. This
      // tick is the natural host — it is already the daily janitor, and it already owns a retention
      // horizon. It runs after the DDL and is therefore skipped on a day the DDL throws; that is the
      // right trade, because a day of unpruned claims is invisible and a partition that never got
      // created is not.
      await this.claims.pruneExpiredClaims(firedAt);
      return { ran: true };
    } catch (e) {
      this.logger.error(`partition maintenance tick failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ran: false, reason: 'ERROR' };
    }
  }

  async runMaintenance(now: Date = new Date()): Promise<MaintenanceResult> {
    const retentionDays = resolveRetentionDays(await this.settings.get<number>(TELEMETRY_RETENTION_DAYS_KEY));
    const existing = await this.listPartitions();
    const plan = planPartitionMaintenance({ existing, now, retentionDays, createAheadDays: CREATE_AHEAD_DAYS });

    await this.applyPlan(plan);

    if (plan.toCreate.length || plan.toDrop.length) {
      this.logger.log(
        `partition maintenance (retention ${retentionDays}d): +${plan.toCreate.length} created, ` +
          `-${plan.toDrop.length} dropped`,
      );
    }
    return { retentionDays, created: plan.toCreate.map((p) => p.name), dropped: plan.toDrop };
  }

  /** Live child-partition names of `raw_device_snapshots` (incl. the DEFAULT; the planner filters it). */
  private async listPartitions(): Promise<string[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ relname: string }[]>(
      `SELECT c.relname
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'raw_device_snapshots'`,
    );
    return rows.map((r) => r.relname);
  }

  private async applyPlan(plan: MaintenancePlan): Promise<void> {
    for (const spec of plan.toCreate) {
      this.assertSafeName(spec.name);
      await this.prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "${spec.name}" PARTITION OF raw_device_snapshots ` +
          `FOR VALUES FROM ('${spec.fromIso}') TO ('${spec.toIso}')`,
      );
    }
    for (const name of plan.toDrop) {
      this.assertSafeName(name);
      await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${name}"`);
    }
  }

  private assertSafeName(name: string): void {
    if (!SAFE_NAME_RE.test(name)) {
      throw new Error(`Refusing DDL on an unexpected partition name: ${name}`);
    }
  }
}
