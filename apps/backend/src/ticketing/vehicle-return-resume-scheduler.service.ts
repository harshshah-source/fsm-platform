import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BUSINESS_TIMEZONE } from '../scheduling/dispatch-cron';
import { VehicleReturnResumeService } from './vehicle-return-resume.service';

/**
 * Default cron for the vehicle-return auto-resume sweep — daily at 03:30 **IST**, first in the daily
 * chain: ahead of the 04:00 schedule closure, the 04:30 eligibility refresh and the 05:00 dispatch
 * tick, so a ticket whose vehicle is due back today has a running primary clock *before* anything can
 * select it. Overridable via `VU_AUTO_RESUME_CRON`, likewise read as an **IST** expression — the job
 * is registered with `timeZone: BUSINESS_TIMEZONE`, so an operator writing "3 30" gets 03:30 in the
 * business timezone on any host.
 *
 * The pinning is the whole of #247 AC4, and #240 is why it is not optional: an unpinned `@Cron` fires
 * in the host process timezone, no `TZ` is set in any compose/Dockerfile/env in this repo, and on a UTC
 * host `30 3 * * *` lands at 09:00 IST — four hours *after* the dispatch it is meant to precede,
 * inverting the ordering the criterion asserts while looking entirely correct in the source.
 */
export const DEFAULT_VU_AUTO_RESUME_CRON = '30 3 * * *';

export interface VehicleReturnResumeConfig {
  /** Shares the pipeline master switch — `BUSINESS_SWEEPS_ENABLED === 'true'`. Default OFF. */
  enabled: boolean;
  resumeCron: string;
}

/** Resolve the master switch + cron in one place; anything but the literal 'true' stays OFF. */
export function readVehicleReturnResumeConfig(env: NodeJS.ProcessEnv = process.env): VehicleReturnResumeConfig {
  return {
    enabled: env.BUSINESS_SWEEPS_ENABLED === 'true',
    resumeCron: env.VU_AUTO_RESUME_CRON?.trim() || DEFAULT_VU_AUTO_RESUME_CRON,
  };
}

/** What the tick reports — a cron body NEVER throws out of the cron context. */
export type VuAutoResumeTickOutcome = { ran: true } | { ran: false; reason: 'DISABLED' | 'RUN_IN_PROGRESS' | 'ERROR' };

/**
 * #247 slice 3 — the tick that drives {@link VehicleReturnResumeService}.
 *
 * It sits BESIDE the #108 business sweeps rather than as a twelfth collaborator on
 * `BusinessSweepSchedulerService`, following `ScheduleClosureScheduler` and
 * `PlantEligibilityRefreshScheduler`. The deciding reason is the timezone, not tidiness: every cron on
 * that scheduler is registered unpinned, which is right for the wall-clock-agnostic ones (every 2, 5,
 * 15 minutes) and would be wrong here — this sweep's entire semantics are "the IST calendar day
 * arrived", and it has to run before the IST-pinned dispatch. Same posture otherwise: the
 * `BUSINESS_SWEEPS_ENABLED` master switch is re-checked every tick, a single-in-flight guard turns an
 * overlapping tick into a logged skip, and the tick returns a structured outcome instead of throwing.
 */
@Injectable()
export class VehicleReturnResumeScheduler {
  private readonly logger = new Logger(VehicleReturnResumeScheduler.name);
  private readonly config: VehicleReturnResumeConfig;
  private inFlight = false;

  constructor(
    private readonly resume: VehicleReturnResumeService,
    config?: Partial<VehicleReturnResumeConfig>,
  ) {
    this.config = { ...readVehicleReturnResumeConfig(), ...config };
  }

  @Cron(readVehicleReturnResumeConfig().resumeCron, { name: 'vu-auto-resume', timeZone: BUSINESS_TIMEZONE })
  async resumeTick(now: Date = new Date()): Promise<VuAutoResumeTickOutcome> {
    if (!this.config.enabled) return { ran: false, reason: 'DISABLED' };
    if (this.inFlight) {
      this.logger.log('vu-auto-resume tick skipped — a sweep is already in flight');
      return { ran: false, reason: 'RUN_IN_PROGRESS' };
    }
    this.inFlight = true;
    try {
      const { resumed } = await this.resume.sweepReturnedVehicles(now);
      if (resumed > 0) this.logger.log(`vu-auto-resume resumed ${resumed} paused SLA clock(s)`);
      return { ran: true };
    } catch (e) {
      this.logger.error(`vu-auto-resume tick failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ran: false, reason: 'ERROR' };
    } finally {
      this.inFlight = false;
    }
  }
}
