import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import type { DispatchRunStatus, DispatchRunTrigger } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { RecommenderService, type RunSummary } from '../recommender/recommender.service';
import { BatchAssignmentService, type DispatchSummary } from './batch-assignment.service';

export interface DispatchRunError {
  zoneId: string;
  message: string;
}

/** Who/what started the run — CRON (default, system actor) or the manual HTTP trigger. */
export interface DispatchRunOptions {
  trigger?: DispatchRunTrigger;
  actorUserId?: string;
  actorRole?: string;
}

export interface DispatchRunSummary {
  /** Active zones processed this run. */
  zones: number;
  /** WorkSchedules dispatched across all zones. */
  schedules: number;
  /** Tickets placed on a Day Plan across all zones. */
  tickets: number;
  /** Zones that failed — recorded, not fatal (the run continues). */
  errors: DispatchRunError[];
  /** dispatch_runs ledger id (string — bigint does not survive JSON serialization). */
  runId: string;
}

/**
 * Issue 113 — the daily Recommender → Day-Plan dispatch run. This is the middle of the funnel that no
 * issue owned: ingestion (#97) ages device state, ticket creation (#112) chains off the telemetry
 * tick, the field-loop sweeps (#108) run unattended — but scoring + dispatch had no caller, so created
 * tickets sat OPEN/UNASSIGNED forever. `runForActiveZones` loops every active zone (a zone with at
 * least one plant) and runs {@link RecommenderService.runForZone} then
 * {@link BatchAssignmentService.dispatchForZone} — the latter is transactional, recommendation-
 * consuming and per-zone advisory-locked (#100), so a re-run the same day is a safe no-op and this
 * loop can sit on a daily timer or a manual trigger.
 *
 * A zone's failure is contained: it is logged + recorded in {@link DispatchRunSummary.errors} and the
 * remaining zones still dispatch. The Schedule Cadence is daily, so the Day Plan covers a single date
 * (`dateFrom === dateTo === the run day`).
 *
 * Transparency ledger (observe-only — records the dispatch, never alters selection/scoring/ordering):
 * every invocation opens a `dispatch_runs` row RUNNING with a config snapshot captured AT RUN START
 * (weights, capacity map, eligibility_mode, scheduler flag/cron — so history shows the config that
 * applied), writes one `dispatch_run_zones` row per zone (totals, mode, unassignable reason buckets,
 * contained error), threads `runId` into the recommender (which writes the per-ticket decision
 * traces) and the dispatcher (which stamps `work_schedules.run_id`), then finalizes
 * SUCCESS/PARTIAL/FAILED. The run is audit-bracketed (DISPATCH_RUN_STARTED/FINISHED) — previously the
 * batch run was an unaudited system actor.
 */
@Injectable()
export class DispatchRunService {
  private readonly logger = new Logger(DispatchRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recommender: RecommenderService,
    private readonly dispatch: BatchAssignmentService,
    // Defaulted so direct construction in tests need not pass it; Nest injects the provider.
    private readonly audit: AuditService = new AuditService(prisma),
  ) {}

  async runForActiveZones(now: Date = new Date(), opts: DispatchRunOptions = {}): Promise<DispatchRunSummary> {
    const trigger: DispatchRunTrigger = opts.trigger ?? 'CRON';
    const actorId = opts.actorUserId ?? 'SYSTEM';
    const actorRole = opts.actorRole ?? 'SYSTEM';
    const day = utcDayStart(now);
    const zoneIds = await this.activeZoneIds();

    const run = await this.prisma.dispatchRun.create({
      data: {
        trigger,
        actorUserId: opts.actorUserId ?? null,
        actorRole: opts.actorRole ?? null,
        startedAt: now,
        configSnapshot: await this.captureConfigSnapshot(),
      },
    });
    await this.audit.record({
      actorId,
      actorRole,
      action: 'DISPATCH_RUN_STARTED',
      entityType: 'dispatch_run',
      entityId: run.runId.toString(),
      metadata: { trigger },
    });

    const summary: DispatchRunSummary = { zones: 0, schedules: 0, tickets: 0, errors: [], runId: run.runId.toString() };
    let batches = 0;
    let recommended = 0;
    let unassignable = 0;

    for (const zoneId of zoneIds) {
      const zoneStart = new Date();
      let rec: RunSummary | undefined;
      try {
        rec = await this.recommender.runForZone(zoneId, { now, runId: run.runId });
        const out = await this.dispatch.dispatchForZone(zoneId, { dateFrom: day, dateTo: day, now, runId: run.runId });
        summary.zones++;
        summary.schedules += out.schedules;
        summary.tickets += out.tickets;
        batches += out.batches;
        recommended += rec.recommended ?? 0;
        unassignable += rec.unassignable ?? 0;
        await this.zoneRow(run.runId, zoneId, zoneStart, rec, out, null);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.error(`dispatch run failed for zone ${zoneId}: ${message}`);
        summary.errors.push({ zoneId: zoneId.toString(), message });
        await this.zoneRow(run.runId, zoneId, zoneStart, rec, undefined, message);
      }
    }

    const status: DispatchRunStatus =
      summary.errors.length === 0
        ? 'SUCCESS'
        : zoneIds.length > 0 && summary.errors.length >= zoneIds.length
          ? 'FAILED'
          : 'PARTIAL';
    await this.prisma.dispatchRun.update({
      where: { runId: run.runId },
      data: {
        finishedAt: new Date(),
        status,
        zones: summary.zones,
        schedules: summary.schedules,
        batches,
        ticketsDispatched: summary.tickets,
        recommended,
        unassignable,
      },
    });
    await this.audit.record({
      actorId,
      actorRole,
      action: 'DISPATCH_RUN_FINISHED',
      entityType: 'dispatch_run',
      entityId: run.runId.toString(),
      metadata: {
        status,
        zones: summary.zones,
        schedules: summary.schedules,
        batches,
        ticketsDispatched: summary.tickets,
        recommended,
        unassignable,
        errorCount: summary.errors.length,
      },
    });

    this.logger.log(
      `dispatch run: ${summary.zones} zones, ${summary.schedules} schedules, ${summary.tickets} tickets, ${summary.errors.length} errors`,
    );
    return summary;
  }

  /** One dispatch_run_zones row per zone — written for successes AND contained failures. */
  private async zoneRow(
    runId: bigint,
    zoneId: bigint,
    startedAt: Date,
    rec: RunSummary | undefined,
    out: DispatchSummary | undefined,
    error: string | null,
  ): Promise<void> {
    await this.prisma.dispatchRunZone.create({
      data: {
        runId,
        zoneId,
        mode: rec?.mode ?? null,
        weightSetRef: rec?.weightSetRef ?? null,
        ticketsConsidered: rec?.ticketsConsidered ?? 0,
        recommended: rec?.recommended ?? 0,
        unassignable: rec?.unassignable ?? 0,
        ...(rec?.unassignableReasons
          ? { unassignableReasons: rec.unassignableReasons as unknown as Prisma.InputJsonValue }
          : {}),
        schedules: out?.schedules ?? 0,
        batches: out?.batches ?? 0,
        ticketsDispatched: out?.tickets ?? 0,
        error,
        startedAt,
        finishedAt: new Date(),
      },
    });
  }

  /**
   * The config in effect AT RUN START, frozen onto the ledger row: active scoring weight sets, the
   * cluster-multiplier and eligibility_mode settings, the per-SE capacity map (the historical "18/25"
   * denominator — a later capacity edit must not rewrite past runs), and the scheduler flag/cron.
   */
  private async captureConfigSnapshot(): Promise<Prisma.InputJsonValue> {
    const [rules, settings, engineers] = await Promise.all([
      this.prisma.priorityRuleConfig.findMany({ where: { active: true }, orderBy: { id: 'asc' } }),
      this.prisma.systemSetting.findMany({ where: { key: { in: ['plant_cluster_multiplier', 'eligibility_mode'] } } }),
      this.prisma.engineerMaster.findMany({ select: { engineerId: true, dailyCapacity: true, isActive: true } }),
    ]);
    return {
      priorityRules: rules.map((r) => ({ weightSetRef: r.weightSetRef, component: r.component, weight: Number(r.weight) })),
      settings: Object.fromEntries(settings.map((s) => [s.key, s.value])) as Prisma.InputJsonValue,
      capacity: Object.fromEntries(
        engineers.map((e) => [e.engineerId, { dailyCapacity: e.dailyCapacity, isActive: e.isActive }]),
      ),
      scheduler: {
        businessSweepsEnabled: process.env.BUSINESS_SWEEPS_ENABLED === 'true',
        // Mirrors DEFAULT_DISPATCH_CRON in dispatch-scheduler.service.ts (not imported — the scheduler
        // imports this service, and its @Cron decorator evaluates at module load, so a cycle is unsafe).
        dispatchCron: process.env.BUSINESS_SWEEP_DISPATCH_CRON?.trim() || '0 5 * * *',
      },
    };
  }

  /** Active zones = zones with at least one plant (the only zones that can carry dispatchable work). */
  private async activeZoneIds(): Promise<bigint[]> {
    const rows = await this.prisma.plant.findMany({ distinct: ['zoneId'], select: { zoneId: true }, orderBy: { zoneId: 'asc' } });
    return rows.map((r) => r.zoneId);
  }
}

/** UTC midnight of the day containing `now` — the daily Day Plan's single coverage date. */
function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
