import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BUSINESS_TIMEZONE } from '../scheduling/dispatch-cron';
import { PlantEligibleFloatingSeService } from './plant-eligible-floating-se.service';

/**
 * Default cron for the periodic `plant_eligible_floating_se` refresh — daily at **04:30 IST** (#254),
 * between the 04:00 IST schedule-closure and the 05:00 IST dispatch tick, so the floating-SE
 * eligibility index is rebuilt from current plants + territory before the morning batch consumes it.
 * Overridable via `PLANT_ELIGIBILITY_REFRESH_CRON`, which is read as an **IST** expression — the
 * registration pins `timeZone: BUSINESS_TIMEZONE`, without which this fired at 04:30 UTC = 10:00 IST
 * on a UTC host, five hours AFTER the batch it feeds (the #240 `schedule-closure` defect, on the one
 * job that fix did not cover).
 */
export const DEFAULT_PLANT_ELIGIBILITY_REFRESH_CRON = '30 4 * * *';

export interface PlantEligibilityRefreshConfig {
  /** Shares the pipeline master switch — `BUSINESS_SWEEPS_ENABLED === 'true'`. Default OFF. */
  enabled: boolean;
  refreshCron: string;
}

/** Resolve the master switch + cron in one place; anything but the literal 'true' stays OFF. */
export function readPlantEligibilityRefreshConfig(
  env: NodeJS.ProcessEnv = process.env,
): PlantEligibilityRefreshConfig {
  return {
    enabled: env.BUSINESS_SWEEPS_ENABLED === 'true',
    refreshCron: env.PLANT_ELIGIBILITY_REFRESH_CRON?.trim() || DEFAULT_PLANT_ELIGIBILITY_REFRESH_CRON,
  };
}

/** What the tick reports — a cron body NEVER throws out of the cron context. */
export type RefreshTickOutcome = { ran: true } | { ran: false; reason: 'DISABLED' | 'RUN_IN_PROGRESS' | 'ERROR' };

/**
 * Issue 138 slice 3 — the periodic backstop that keeps `plant_eligible_floating_se` fresh (AC#3).
 * Territory edits refresh the MV on-write (`SeTerritoryService`) and master-sync refreshes it after a
 * successful run (slice 2), but neither covers a lost post-commit refresh or a plant/district geometry
 * change that lands between runs. A scheduled `REFRESH … CONCURRENTLY` bounds MV staleness so the
 * Recommender's floating leg (Issue 138 slice 1 re-checks identity live, but still reads the MV's
 * plant↔SE geometry) sees current coverage.
 *
 * It sits BESIDE the #108 business sweeps rather than as an 11th collaborator on
 * `BusinessSweepSchedulerService` — the same reasoning `DispatchSchedulerService` follows: a distinct
 * concern kept separate avoids threading another collaborator through that scheduler. Same posture as
 * the other schedulers: the `BUSINESS_SWEEPS_ENABLED` master switch is re-checked every tick, a
 * single-in-flight guard turns an overlapping tick into a logged skip, and the tick returns a structured
 * outcome instead of throwing.
 */
@Injectable()
export class PlantEligibilityRefreshScheduler {
  private readonly logger = new Logger(PlantEligibilityRefreshScheduler.name);
  private readonly config: PlantEligibilityRefreshConfig;
  private inFlight = false;

  constructor(
    private readonly eligibility: PlantEligibleFloatingSeService,
    config?: Partial<PlantEligibilityRefreshConfig>,
  ) {
    this.config = { ...readPlantEligibilityRefreshConfig(), ...config };
  }

  @Cron(readPlantEligibilityRefreshConfig().refreshCron, { name: 'plant-eligibility-refresh', timeZone: BUSINESS_TIMEZONE })
  async refreshTick(): Promise<RefreshTickOutcome> {
    if (!this.config.enabled) return { ran: false, reason: 'DISABLED' };
    if (this.inFlight) {
      this.logger.log('plant-eligibility refresh skipped — a refresh is already in flight');
      return { ran: false, reason: 'RUN_IN_PROGRESS' };
    }
    this.inFlight = true;
    try {
      await this.eligibility.refresh();
      return { ran: true };
    } catch (e) {
      this.logger.error(`plant-eligibility refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ran: false, reason: 'ERROR' };
    } finally {
      this.inFlight = false;
    }
  }
}
