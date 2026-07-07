import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CrossZoneEscalationService } from '../cross-zone/cross-zone-escalation.service';
import { IntradayInsertionService } from '../intraday/intraday-insertion.service';
import { FleetUptimeAggregationService } from '../reports/fleet-uptime-aggregation.service';
import { RootCauseAnalyticsAggregationService } from '../reports/root-cause-aggregation.service';
import { SoftInactiveCountService } from '../reports/soft-inactive-count.service';
import { SystemEfficiencyAggregationService } from '../reports/system-efficiency-aggregation.service';
import { ZmPerformanceAggregationService } from '../reports/zm-performance-aggregation.service';
import { InstallLifecycleService } from '../ticketing/install-lifecycle.service';
import { RepeatEscalationService } from '../ticketing/repeat-escalation.service';
import { VerificationService } from '../verification/verification.service';

/**
 * Default cron expressions — the ONE place the business-sweep cadence is documented (AC#4). Each is
 * overridable by the matching `BUSINESS_SWEEP_*_CRON` env var. Cadence rationale:
 *   - verification / install-verification: minutes-scale — a VERIFICATION_PENDING ticket must resolve
 *     quickly; a 5-min lag is invisible to the field.
 *   - intraday timeouts: 2-min — the Issue 30 contract is a 10-min acceptance window, so sub-window
 *     granularity keeps reroute latency small.
 *   - cross-zone / repeat escalation: ~15-min — SLA-breach detection, not real-time.
 *   - soft-inactive: twice daily (06:00 / 18:00 UTC) — the Issue 40 snapshot cadence.
 *   - system-efficiency: daily (01:30 UTC) — finalises the day just ended.
 *   - fleet-uptime / root-cause / zm-performance: month-start (03:00-03:30 on the 1st) — finalise the
 *     month just ended; staggered so three heavy recomputes never start the same minute.
 */
export const DEFAULT_VERIFICATION_CRON = '*/5 * * * *';
export const DEFAULT_INSTALL_VERIFICATION_CRON = '*/5 * * * *';
export const DEFAULT_INTRADAY_TIMEOUT_CRON = '*/2 * * * *';
export const DEFAULT_CROSS_ZONE_CRON = '*/15 * * * *';
export const DEFAULT_REPEAT_ESCALATION_CRON = '*/15 * * * *';
export const DEFAULT_SOFT_INACTIVE_CRON = '0 6,18 * * *';
export const DEFAULT_SYSTEM_EFFICIENCY_CRON = '30 1 * * *';
export const DEFAULT_FLEET_UPTIME_CRON = '0 3 1 * *';
export const DEFAULT_ROOT_CAUSE_CRON = '15 3 1 * *';
export const DEFAULT_ZM_PERFORMANCE_CRON = '30 3 1 * *';

export interface BusinessSweepSchedulerConfig {
  /** Master switch — `BUSINESS_SWEEPS_ENABLED === 'true'`. Default OFF (enabling is an ops step). */
  enabled: boolean;
  verificationCron: string;
  installVerificationCron: string;
  intradayTimeoutCron: string;
  crossZoneCron: string;
  repeatEscalationCron: string;
  softInactiveCron: string;
  systemEfficiencyCron: string;
  fleetUptimeCron: string;
  rootCauseCron: string;
  zmPerformanceCron: string;
}

/** Resolve the master switch + every cron in one place; anything but the literal 'true' stays OFF. */
export function readBusinessSweepSchedulerConfig(
  env: NodeJS.ProcessEnv = process.env,
): BusinessSweepSchedulerConfig {
  return {
    enabled: env.BUSINESS_SWEEPS_ENABLED === 'true',
    verificationCron: env.BUSINESS_SWEEP_VERIFICATION_CRON?.trim() || DEFAULT_VERIFICATION_CRON,
    installVerificationCron: env.BUSINESS_SWEEP_INSTALL_VERIFICATION_CRON?.trim() || DEFAULT_INSTALL_VERIFICATION_CRON,
    intradayTimeoutCron: env.BUSINESS_SWEEP_INTRADAY_TIMEOUT_CRON?.trim() || DEFAULT_INTRADAY_TIMEOUT_CRON,
    crossZoneCron: env.BUSINESS_SWEEP_CROSS_ZONE_CRON?.trim() || DEFAULT_CROSS_ZONE_CRON,
    repeatEscalationCron: env.BUSINESS_SWEEP_REPEAT_ESCALATION_CRON?.trim() || DEFAULT_REPEAT_ESCALATION_CRON,
    softInactiveCron: env.BUSINESS_SWEEP_SOFT_INACTIVE_CRON?.trim() || DEFAULT_SOFT_INACTIVE_CRON,
    systemEfficiencyCron: env.BUSINESS_SWEEP_SYSTEM_EFFICIENCY_CRON?.trim() || DEFAULT_SYSTEM_EFFICIENCY_CRON,
    fleetUptimeCron: env.BUSINESS_SWEEP_FLEET_UPTIME_CRON?.trim() || DEFAULT_FLEET_UPTIME_CRON,
    rootCauseCron: env.BUSINESS_SWEEP_ROOT_CAUSE_CRON?.trim() || DEFAULT_ROOT_CAUSE_CRON,
    zmPerformanceCron: env.BUSINESS_SWEEP_ZM_PERFORMANCE_CRON?.trim() || DEFAULT_ZM_PERFORMANCE_CRON,
  };
}

/** What a manually-invokable cron handler reports — a tick NEVER throws out of a cron context. */
export type SchedulerTickOutcome =
  | { ran: true }
  | { ran: false; reason: 'DISABLED' | 'RUN_IN_PROGRESS' | 'ERROR' };

/** Previous UTC month-start relative to `now` — the month a month-start tick finalises. */
function previousUtcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
}
/** Previous UTC day-start relative to `now` — the day a daily tick finalises. */
function previousUtcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
}

/**
 * Issue 108 — in-process `@nestjs/schedule` scheduler for the business-facing periodic loops
 * (verification, intraday acceptance-timeout, cross-zone auto-escalation, install verification,
 * repeat escalation, and the report cubes). Mirrors {@link IntegrationSchedulerService}: the master
 * switch (`BUSINESS_SWEEPS_ENABLED`) is re-checked on every tick, each handler returns a structured
 * {@link SchedulerTickOutcome} and never throws out of the cron context, and a per-sweep
 * single-in-flight guard turns an overlapping tick into a logged RUN_IN_PROGRESS skip (the underlying
 * sweeps carry no guard of their own). There is no external-source gate — the sweeps run against the
 * local Postgres, always "configured"; the only dormant reason is DISABLED.
 *
 * The existing authenticated HTTP triggers remain as manual overrides. Each tick threads its clock
 * into the sweep so tests stay sweep-driven (injected `now`).
 */
@Injectable()
export class BusinessSweepSchedulerService {
  private readonly logger = new Logger(BusinessSweepSchedulerService.name);
  private readonly config: BusinessSweepSchedulerConfig;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly verification: VerificationService,
    private readonly intraday: IntradayInsertionService,
    private readonly crossZone: CrossZoneEscalationService,
    private readonly installLifecycle: InstallLifecycleService,
    private readonly repeatEscalation: RepeatEscalationService,
    private readonly softInactive: SoftInactiveCountService,
    private readonly fleetUptime: FleetUptimeAggregationService,
    private readonly rootCause: RootCauseAnalyticsAggregationService,
    private readonly zmPerformance: ZmPerformanceAggregationService,
    private readonly systemEfficiency: SystemEfficiencyAggregationService,
    config?: Partial<BusinessSweepSchedulerConfig>,
  ) {
    this.config = { ...readBusinessSweepSchedulerConfig(), ...config };
  }

  /**
   * The uniform tick body: dormant-gate → single-in-flight guard → run the sweep in a try/catch →
   * structured outcome. `name` is both the guard key and the log label.
   */
  private async runGuarded(name: string, run: () => Promise<unknown>): Promise<SchedulerTickOutcome> {
    if (!this.config.enabled) return { ran: false, reason: 'DISABLED' };
    if (this.inFlight.has(name)) {
      this.logger.log(`${name} tick skipped — a run is already in flight`);
      return { ran: false, reason: 'RUN_IN_PROGRESS' };
    }
    this.inFlight.add(name);
    try {
      await run();
      return { ran: true };
    } catch (e) {
      this.logger.error(`${name} tick failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ran: false, reason: 'ERROR' };
    } finally {
      this.inFlight.delete(name);
    }
  }

  @Cron(readBusinessSweepSchedulerConfig().verificationCron, { name: 'business-verification' })
  verificationTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded('verification', () => this.verification.runVerification(now));
  }

  @Cron(readBusinessSweepSchedulerConfig().installVerificationCron, { name: 'business-install-verification' })
  installVerificationTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded('install-verification', () => this.installLifecycle.runInstallVerification(now));
  }

  @Cron(readBusinessSweepSchedulerConfig().intradayTimeoutCron, { name: 'business-intraday-timeout' })
  intradayTimeoutTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded('intraday-timeout', () => this.intraday.sweepTimeouts(now));
  }

  @Cron(readBusinessSweepSchedulerConfig().crossZoneCron, { name: 'business-cross-zone' })
  crossZoneTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded('cross-zone', () => this.crossZone.sweepAutoEscalations(now));
  }

  @Cron(readBusinessSweepSchedulerConfig().repeatEscalationCron, { name: 'business-repeat-escalation' })
  repeatEscalationTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded('repeat-escalation', () => this.repeatEscalation.runEscalationScan(now));
  }

  @Cron(readBusinessSweepSchedulerConfig().softInactiveCron, { name: 'business-soft-inactive' })
  softInactiveTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded('soft-inactive', () => this.softInactive.recompute(now));
  }

  @Cron(readBusinessSweepSchedulerConfig().systemEfficiencyCron, { name: 'business-system-efficiency' })
  systemEfficiencyTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded('system-efficiency', () => this.systemEfficiency.computeDay(previousUtcDayStart(now), now));
  }

  @Cron(readBusinessSweepSchedulerConfig().fleetUptimeCron, { name: 'business-fleet-uptime' })
  fleetUptimeTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded('fleet-uptime', () => this.fleetUptime.computeMonth(previousUtcMonthStart(now), now));
  }

  @Cron(readBusinessSweepSchedulerConfig().rootCauseCron, { name: 'business-root-cause' })
  rootCauseTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded('root-cause', () => this.rootCause.computeMonth(previousUtcMonthStart(now), now));
  }

  @Cron(readBusinessSweepSchedulerConfig().zmPerformanceCron, { name: 'business-zm-performance' })
  zmPerformanceTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded('zm-performance', () => this.zmPerformance.computeMonth(previousUtcMonthStart(now), now));
  }
}
