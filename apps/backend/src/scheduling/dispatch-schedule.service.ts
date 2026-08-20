import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { PrismaService } from '../prisma/prisma.service';
import {
  BUSINESS_TIMEZONE,
  DISPATCH_CRON_SETTING_KEY,
  DISPATCH_JOB_NAME,
  bootstrapDispatchCron,
  cronTimeCtorOf,
  nextFireAt,
  validateDispatchCron,
  type ReschedulableCronJob,
} from './dispatch-cron';

/** Shown beside the value in the settings registry. */
export const DISPATCH_CRON_DESCRIPTION =
  'Daily Recommender → Day-Plan dispatch run schedule (cron, Asia/Kolkata). Operations-Head-owned; ' +
  'write it through PUT /api/schedules/dispatch-schedule so it is validated and the job re-registered.';

export interface DispatchScheduleView {
  cron: string;
  timeZone: string;
  /** When the job next fires, absolute — so an operator can confirm the change took, not just that it saved. */
  nextFireAt: string;
}

export type SetDispatchScheduleOutcome =
  | { result: 'OK'; schedule: DispatchScheduleView }
  | { result: 'INVALID'; reason: string };

/**
 * #213 — the daily dispatch schedule as **operator-owned configuration** rather than an environment
 * variable, and the owner of the registered job's lifecycle.
 *
 * `system_settings.dispatch_cron` is the source of truth. `BUSINESS_SWEEP_DISPATCH_CRON` is demoted to
 * a bootstrap default, read once when no row exists and never again — so changing the hour is a
 * settings edit, not a redeploy.
 *
 * Two guarantees drive the shape here, both from the operator ruling on #198 Q2:
 *
 * 1. **A change takes effect without a restart.** `@Cron` evaluates its expression once at
 *    class-decoration time, so a write has to re-register the job — {@link setCron} calls `setTime` on
 *    the live job. Reading the setting per tick is explicitly *not* an acceptable substitute: the job
 *    would still wake on the old schedule and merely decide whether to act.
 * 2. **An invalid expression is rejected at write time and the previous schedule keeps firing.** The
 *    order below matters — validate, then persist, then re-register — so a bad value never reaches
 *    either the row or the registry. A schedule that is quietly dead surfaces only when someone notices
 *    there is no day plan.
 */
@Injectable()
export class DispatchScheduleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DispatchScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SchedulerRegistry,
    private readonly audit: AuditService,
  ) {}

  /**
   * Seed the setting row at boot (#213 AC-1) and apply it **if the job is already mounted**.
   *
   * It usually is not (#257): `@nestjs/schedule` discovers `@Cron` methods at module-init but only
   * mounts them into `SchedulerRegistry` in `SchedulerOrchestrator`'s own `onApplicationBootstrap` —
   * and Nest runs bootstrap hooks deepest-module-first (`b.distance - a.distance`), which on this
   * app's graph puts THIS hook before the orchestrator's. From here the job's absence is documented
   * framework ordering, not a defect, so it defers quietly; the authoritative application is
   * {@link applyStoredSchedule}, called from `main.ts` once bootstrap has completed — the only point
   * Nest actually guarantees every module's hook has run. (The previous version treated the missing
   * job as a bad stored expression and logged an ERROR on every boot while staying on the
   * compile-time default — which meant an operator's schedule silently did not survive a restart.)
   */
  async onApplicationBootstrap(): Promise<void> {
    const cron = await this.resolveCron();
    if (this.registry.doesExist('cron', DISPATCH_JOB_NAME)) {
      this.applyResolved(cron);
    } else {
      this.logger.log(`dispatch schedule '${cron}' stored; job not mounted yet — applied after bootstrap (main.ts)`);
    }
  }

  /**
   * Bring the registered job in line with the stored schedule — the boot-path step `main.ts` runs
   * after `app.listen()` (#257 AC-4). Idempotent; safe to call any time after bootstrap.
   */
  async applyStoredSchedule(): Promise<void> {
    this.applyResolved(await this.resolveCron());
  }

  private applyResolved(cron: string): void {
    try {
      this.applyToJob(cron);
      this.logger.log(`dispatch schedule '${cron}' (${BUSINESS_TIMEZONE}) — next fire ${this.nextFire().toISOString()}`);
    } catch (e) {
      // A stored expression the parser rejects (hand-edited row, or a library change) must not take the
      // app down — the job stays on its previous schedule and the discrepancy is logged loudly.
      this.logger.error(
        `stored dispatch schedule '${cron}' could not be applied, staying on the previous schedule: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** The schedule in force, with its next fire — the read behind `GET /schedules/dispatch-schedule`. */
  async current(): Promise<DispatchScheduleView> {
    return { cron: await this.resolveCron(), timeZone: BUSINESS_TIMEZONE, nextFireAt: this.nextFire().toISOString() };
  }

  /**
   * Write a new schedule: validate → persist (audited, with both values) → re-register the live job.
   * Returns `INVALID` rather than throwing so the controller owns the HTTP shape, matching the outcome
   * unions the rest of this codebase uses.
   */
  async setCron(expression: unknown, actor: RequestActor): Promise<SetDispatchScheduleOutcome> {
    const validation = validateDispatchCron(expression, cronTimeCtorOf(this.job()));
    if (!validation.valid) return { result: 'INVALID', reason: validation.reason };

    const next = (expression as string).trim();
    const previous = await this.resolveCron();

    // One audited transaction carrying BOTH values (#213 AC-5) — `SettingsService.set` records only
    // that the key changed, which does not answer "what was it before?" three weeks later.
    await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'DISPATCH_SCHEDULE_UPDATED',
        entityType: 'system_settings',
        entityId: DISPATCH_CRON_SETTING_KEY,
        metadata: { previous, next, timeZone: BUSINESS_TIMEZONE },
      },
      async (tx) => {
        await tx.systemSetting.upsert({
          where: { key: DISPATCH_CRON_SETTING_KEY },
          create: { key: DISPATCH_CRON_SETTING_KEY, value: next, description: DISPATCH_CRON_DESCRIPTION },
          update: { value: next },
        });
      },
    );

    this.applyToJob(next);
    const schedule = { cron: next, timeZone: BUSINESS_TIMEZONE, nextFireAt: this.nextFire().toISOString() };
    this.logger.log(`dispatch schedule changed '${previous}' → '${next}' — next fire ${schedule.nextFireAt}`);
    return { result: 'OK', schedule };
  }

  /**
   * The stored schedule, seeding it from the bootstrap default the first time. The seed is create-only,
   * so a later redeploy with a different environment variable never clobbers an operator's setting.
   */
  private async resolveCron(): Promise<string> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: DISPATCH_CRON_SETTING_KEY } });
    if (typeof row?.value === 'string' && row.value.trim() !== '') return row.value;

    const seeded = bootstrapDispatchCron();
    await this.prisma.systemSetting.upsert({
      where: { key: DISPATCH_CRON_SETTING_KEY },
      create: { key: DISPATCH_CRON_SETTING_KEY, value: seeded, description: DISPATCH_CRON_DESCRIPTION },
      update: { value: seeded },
    });
    return seeded;
  }

  private job(): ReschedulableCronJob {
    return this.registry.getCronJob(DISPATCH_JOB_NAME) as unknown as ReschedulableCronJob;
  }

  private nextFire(): Date {
    return nextFireAt(this.job());
  }

  /** Re-point the live job. `setTime` stops and restarts it, which is what makes this restart-free. */
  private applyToJob(cron: string): void {
    const job = this.job();
    const CronTime = cronTimeCtorOf(job);
    job.setTime(new CronTime(cron, BUSINESS_TIMEZONE));
    job.start();
  }
}
