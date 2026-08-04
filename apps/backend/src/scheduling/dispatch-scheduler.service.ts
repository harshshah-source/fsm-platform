import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { SchedulerTickOutcome } from './business-sweep-scheduler.service';
import { DispatchRunService } from './dispatch-run.service';

/**
 * The business timezone (CONTEXT.md Decisions §19, ruled 2026-08-04). Every scheduled business job
 * that means a wall-clock hour to an operator must pin this — an unpinned `@Cron` fires in the host
 * process timezone, and no `TZ` is set in any compose/Dockerfile/env in this repo, so "05:00" landed
 * at 10:30 IST on a UTC host: hours *into* the field day the run is meant to precede.
 */
export const BUSINESS_TIMEZONE = 'Asia/Kolkata';

/**
 * Default cron for the daily Recommender → Day-Plan dispatch run — 05:00 **IST**, before the field day
 * starts (Schedule Cadence: daily). Overridable via `BUSINESS_SWEEP_DISPATCH_CRON`.
 *
 * #213 supersedes the env var as the source of truth: the schedule moves into `system_settings` with
 * this value demoted to the bootstrap default used only when no setting row exists. Note the `@Cron`
 * decorator below evaluates its expression once at class-decoration time, which is precisely why
 * #213 has to re-register the job on write rather than re-read the value per tick.
 */
export const DEFAULT_DISPATCH_CRON = '0 5 * * *';

export interface DispatchSchedulerConfig {
  /** Shares the #108 master switch — `BUSINESS_SWEEPS_ENABLED === 'true'`. Default OFF (an ops step). */
  enabled: boolean;
  dispatchCron: string;
}

/** Resolve the master switch + cron in one place; anything but the literal 'true' stays OFF. */
export function readDispatchSchedulerConfig(env: NodeJS.ProcessEnv = process.env): DispatchSchedulerConfig {
  return {
    enabled: env.BUSINESS_SWEEPS_ENABLED === 'true',
    dispatchCron: env.BUSINESS_SWEEP_DISPATCH_CRON?.trim() || DEFAULT_DISPATCH_CRON,
  };
}

/**
 * Issue 113 — the daily dispatch tick that turns created-but-unassigned tickets into SE Day Plans
 * without a human. It sits *beside* the #108 BusinessSweepScheduler (not inside it — dispatch is a
 * distinct concern from the field-loop sweeps, and keeping it separate avoids threading an 11th
 * collaborator through that scheduler) but wears the same posture: gated by the shared
 * `BUSINESS_SWEEPS_ENABLED` master switch (re-checked every tick), a single-in-flight guard so a slow
 * run never overlaps the next cron fire, and a structured {@link SchedulerTickOutcome} that never
 * throws out of the cron context. {@link DispatchRunService.runForActiveZones} is idempotent
 * (recommendation-consuming + per-zone advisory-locked, #100), so a same-day re-run is safe. The
 * manual `POST /api/schedules/dispatch-run` trigger drives the exact same code path.
 */
@Injectable()
export class DispatchSchedulerService {
  private readonly logger = new Logger(DispatchSchedulerService.name);
  private readonly config: DispatchSchedulerConfig;
  private inFlight = false;

  constructor(
    private readonly dispatchRun: DispatchRunService,
    config?: Partial<DispatchSchedulerConfig>,
  ) {
    this.config = { ...readDispatchSchedulerConfig(), ...config };
  }

  @Cron(readDispatchSchedulerConfig().dispatchCron, { name: 'business-dispatch', timeZone: BUSINESS_TIMEZONE })
  async dispatchTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    if (!this.config.enabled) return { ran: false, reason: 'DISABLED' };
    if (this.inFlight) {
      this.logger.log('dispatch tick skipped — a run is already in flight');
      return { ran: false, reason: 'RUN_IN_PROGRESS' };
    }
    this.inFlight = true;
    try {
      await this.dispatchRun.runForActiveZones(now);
      return { ran: true };
    } catch (e) {
      this.logger.error(`dispatch tick failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ran: false, reason: 'ERROR' };
    } finally {
      this.inFlight = false;
    }
  }
}
