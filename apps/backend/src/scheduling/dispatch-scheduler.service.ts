import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { SchedulerTickOutcome } from './business-sweep-scheduler.service';
import {
  BUSINESS_TIMEZONE,
  DEFAULT_DISPATCH_CRON,
  DEFAULT_DISPATCH_REAPER_CRON,
  DISPATCH_JOB_NAME,
  DISPATCH_REAPER_JOB_NAME,
  type DispatchRetryPolicy,
  bootstrapDispatchCron,
  readDispatchRetryPolicy,
} from './dispatch-cron';
import { DispatchRunService } from './dispatch-run.service';

// Re-exported for the callers that predate `dispatch-cron.ts` (#213 moved the definitions there so the
// settings-backed writer and the scheduler could share them without a cycle).
export { BUSINESS_TIMEZONE, DEFAULT_DISPATCH_CRON } from './dispatch-cron';

export interface DispatchSchedulerConfig {
  /** Shares the #108 master switch — `BUSINESS_SWEEPS_ENABLED === 'true'`. Default OFF (an ops step). */
  enabled: boolean;
  dispatchCron: string;
  /**
   * #260 — how patient the automatic run is with a contended zone. Carried on the scheduler's config
   * rather than read from the environment inside the run, for the reason #182 R5 gives: a spec that
   * needs a different value passes it through this constructor param, never by setting an env var the
   * suite's allowlist would (correctly) delete.
   */
  retry: DispatchRetryPolicy;
}

/**
 * Resolve the master switch + the **bootstrap** cron; anything but the literal 'true' stays OFF.
 *
 * #213 — `dispatchCron` here is no longer what the job runs on. `system_settings.dispatch_cron` is the
 * source of truth and `DispatchScheduleService` applies it at boot and on every write; this env value
 * seeds that row the first time and is not read again. The master switch is unchanged and stays an
 * env-level ops gate (#108's design).
 */
export function readDispatchSchedulerConfig(env: NodeJS.ProcessEnv = process.env): DispatchSchedulerConfig {
  return {
    enabled: env.BUSINESS_SWEEPS_ENABLED === 'true',
    dispatchCron: bootstrapDispatchCron(env),
    retry: readDispatchRetryPolicy(env),
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

  constructor(
    private readonly dispatchRun: DispatchRunService,
    config?: Partial<DispatchSchedulerConfig>,
  ) {
    this.config = { ...readDispatchSchedulerConfig(), ...config };
  }

  /**
   * The decorator registers the job and pins its name + timezone; the **expression here is only the
   * compile-time default**. `@Cron` evaluates its argument once at class-decoration time, long before a
   * database is reachable, so the stored schedule cannot be read here — `DispatchScheduleService`
   * re-points this same job at the configured expression in its `onModuleInit`, and again on every
   * write (#213). That indirection is the reason the decorator no longer reads the environment: the
   * env var seeds the setting row once and is not a parallel source afterwards.
   */
  @Cron(DEFAULT_DISPATCH_CRON, { name: DISPATCH_JOB_NAME, timeZone: BUSINESS_TIMEZONE })
  async dispatchTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    if (!this.config.enabled) return { ran: false, reason: 'DISABLED' };
    try {
      // #213 — the in-flight guard is no longer a private field here. It moved into
      // `runForActiveZones`, the one path this tick and the manual HTTP trigger share, so neither can
      // start a run over the other; this tick just reports the refusal it is handed.
      // #260 — the tick is patient with a contended zone: a collision measured in seconds must not
      // cost that zone its daily dispatch. The waiting happens inside `runForActiveZones`, so the
      // manual trigger sharing this path is unaffected (it is never patient), and a CONFLICT reaching
      // here now means the deadline expired rather than that the first attempt was refused.
      const outcome = await this.dispatchRun.runForActiveZones(now, { retry: this.config.retry });
      if (outcome.result === 'CONFLICT') {
        const zones = outcome.inFlight.map((f) => f.zoneId).join(', ');
        this.logger.log(
          `dispatch tick skipped — a run is still in flight for zone(s) ${zones} after waiting ` +
            `${this.config.retry.deadlineMs} ms`,
        );
        return { ran: false, reason: 'RUN_IN_PROGRESS' };
      }
      return { ran: true };
    } catch (e) {
      this.logger.error(`dispatch tick failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ran: false, reason: 'ERROR' };
    }
  }

  /**
   * #261 — free the zones of runs whose process stopped existing, on a timer.
   *
   * `runForActiveZones` already reaps before it admits, which covers a busy system completely. It
   * covers a quiet one not at all: if nothing asks for a zone until 05:00 tomorrow, a claim abandoned
   * at 05:02 today spends a whole day refusing that zone, and the only reason it eventually clears is
   * that somebody happened to ask. This tick removes the dependence on somebody asking.
   *
   * It deliberately does **not** dispatch. A reaper that also ran the zones it freed would turn "clean
   * up after a crash" into an unscheduled dispatch run at an arbitrary minute of the day, which is the
   * schedule's decision to make, not the janitor's — #260 owns retrying a zone that was contended.
   */
  @Cron(DEFAULT_DISPATCH_REAPER_CRON, { name: DISPATCH_REAPER_JOB_NAME, timeZone: BUSINESS_TIMEZONE })
  async dispatchReaperTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    if (!this.config.enabled) return { ran: false, reason: 'DISABLED' };
    try {
      const { runs, claims } = await this.dispatchRun.reapStaleDispatchRuns(now);
      if (runs > 0) this.logger.warn(`dispatch reaper tick: aborted ${runs} run(s), freed ${claims} claim(s)`);
      return { ran: true };
    } catch (e) {
      this.logger.error(`dispatch reaper tick failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ran: false, reason: 'ERROR' };
    }
  }
}
