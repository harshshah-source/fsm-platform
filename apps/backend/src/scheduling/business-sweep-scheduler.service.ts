import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { TickClaimant } from './cron-tick-claim';
import { CrossZoneEscalationService } from '../cross-zone/cross-zone-escalation.service';
import { DAY_PLAN_NOTIFIER, type DayPlanNotifier } from './day-plan-notifier';
import { drainUnsent } from './day-plan-notification-outbox';
import { NotificationService } from '../notifications/notification.service';
import { IntradayInsertionService } from '../intraday/intraday-insertion.service';
import { TierOverrideExpiryService } from '../org/tier-override-expiry.service';
import { PrismaService } from '../prisma/prisma.service';
import { FleetUptimeAggregationService } from '../reports/fleet-uptime-aggregation.service';
import { RootCauseAnalyticsAggregationService } from '../reports/root-cause-aggregation.service';
import { SoftInactiveCountService } from '../reports/soft-inactive-count.service';
import { SystemEfficiencyAggregationService } from '../reports/system-efficiency-aggregation.service';
import { ZmPerformanceAggregationService } from '../reports/zm-performance-aggregation.service';
import { InstallLifecycleService } from '../ticketing/install-lifecycle.service';
import { INSTALL_NOTIFIER, type InstallNotifier } from '../ticketing/install-notifier';
import { RECOVERY_NOTIFIER, type RecoveryNotifier } from '../ticketing/recovery-notifier';
import { RepeatEscalationService } from '../ticketing/repeat-escalation.service';
import { VerificationService } from '../verification/verification.service';

/**
 * Default cron expressions — the ONE place the business-sweep cadence is documented (AC#4). Each is
 * overridable by the matching `BUSINESS_SWEEP_*_CRON` env var. Cadence rationale:
 *   - verification / install-verification: minutes-scale — a VERIFICATION_PENDING ticket must resolve
 *     quickly; a 5-min lag is invisible to the field.
 *   - critical-assign: 2-min — #268's direct-assignment sweep; sub-5-min so a newly-CRITICAL ticket
 *     is on an SE's Day Plan within minutes, not the verification sweep's cadence.
 *   - cross-zone / repeat escalation: ~15-min — SLA-breach detection, not real-time.
 *   - tier-override-expiry (Issue 157): hourly — status truthfulness for the report/audit trail
 *     only, never for correctness (the effective-tier resolver predicates on `expiresAt`, not
 *     `status`, so nothing dispatch-relevant depends on this sweep's cadence).
 *   - soft-inactive: twice daily (06:00 / 18:00 UTC) — the Issue 40 snapshot cadence.
 *   - system-efficiency: daily (01:30 UTC) — finalises the day just ended.
 *   - fleet-uptime / root-cause / zm-performance: month-start (03:00-03:30 on the 1st) — finalise the
 *     month just ended; staggered so three heavy recomputes never start the same minute.
 */
/**
 * #263 — the registered cron-job names, in the ONE place the decorator and the tick claim can share
 * them. They were literals in eleven `@Cron` options objects; the claim key has to be globally unique
 * across the whole app (`cron_tick_claims` is one table for nineteen jobs), and the registered name
 * already is — it is what `scheduler-wiring.e2e-spec.ts` pins. Re-deriving it as a second literal
 * beside the first is how the two drift.
 */
export const BUSINESS_SWEEP_JOBS = {
  verification: 'business-verification',
  installVerification: 'business-install-verification',
  criticalAssign: 'business-critical-assign',
  crossZone: 'business-cross-zone',
  repeatEscalation: 'business-repeat-escalation',
  tierOverrideExpiry: 'business-tier-override-expiry',
  softInactive: 'business-soft-inactive',
  systemEfficiency: 'business-system-efficiency',
  fleetUptime: 'business-fleet-uptime',
  rootCause: 'business-root-cause',
  zmPerformance: 'business-zm-performance',
  // #264 — the day-plan notification outbox re-drain sweep.
  notificationOutbox: 'business-notification-outbox',
} as const;

export const DEFAULT_VERIFICATION_CRON = '*/5 * * * *';
export const DEFAULT_INSTALL_VERIFICATION_CRON = '*/5 * * * *';
export const DEFAULT_CRITICAL_ASSIGN_CRON = '*/2 * * * *';
export const DEFAULT_CROSS_ZONE_CRON = '*/15 * * * *';
export const DEFAULT_REPEAT_ESCALATION_CRON = '*/15 * * * *';
export const DEFAULT_TIER_OVERRIDE_EXPIRY_CRON = '0 * * * *';
export const DEFAULT_SOFT_INACTIVE_CRON = '0 6,18 * * *';
export const DEFAULT_SYSTEM_EFFICIENCY_CRON = '30 1 * * *';
export const DEFAULT_FLEET_UPTIME_CRON = '0 3 1 * *';
export const DEFAULT_ROOT_CAUSE_CRON = '15 3 1 * *';
export const DEFAULT_ZM_PERFORMANCE_CRON = '30 3 1 * *';
// #264 — minute-cadence family (the immediate post-commit drain already delivers the common case;
// this is the crash-between-commit-and-drain backstop, not the primary path).
export const DEFAULT_NOTIFICATION_OUTBOX_CRON = '*/2 * * * *';

export interface BusinessSweepSchedulerConfig {
  /** Master switch — `BUSINESS_SWEEPS_ENABLED === 'true'`. Default OFF (enabling is an ops step). */
  enabled: boolean;
  verificationCron: string;
  installVerificationCron: string;
  criticalAssignCron: string;
  crossZoneCron: string;
  repeatEscalationCron: string;
  tierOverrideExpiryCron: string;
  softInactiveCron: string;
  systemEfficiencyCron: string;
  fleetUptimeCron: string;
  rootCauseCron: string;
  zmPerformanceCron: string;
  notificationOutboxCron: string;
}

/** Resolve the master switch + every cron in one place; anything but the literal 'true' stays OFF. */
export function readBusinessSweepSchedulerConfig(
  env: NodeJS.ProcessEnv = process.env,
): BusinessSweepSchedulerConfig {
  return {
    enabled: env.BUSINESS_SWEEPS_ENABLED === 'true',
    verificationCron: env.BUSINESS_SWEEP_VERIFICATION_CRON?.trim() || DEFAULT_VERIFICATION_CRON,
    installVerificationCron: env.BUSINESS_SWEEP_INSTALL_VERIFICATION_CRON?.trim() || DEFAULT_INSTALL_VERIFICATION_CRON,
    criticalAssignCron: env.BUSINESS_SWEEP_CRITICAL_ASSIGN_CRON?.trim() || DEFAULT_CRITICAL_ASSIGN_CRON,
    crossZoneCron: env.BUSINESS_SWEEP_CROSS_ZONE_CRON?.trim() || DEFAULT_CROSS_ZONE_CRON,
    repeatEscalationCron: env.BUSINESS_SWEEP_REPEAT_ESCALATION_CRON?.trim() || DEFAULT_REPEAT_ESCALATION_CRON,
    tierOverrideExpiryCron: env.BUSINESS_SWEEP_TIER_OVERRIDE_EXPIRY_CRON?.trim() || DEFAULT_TIER_OVERRIDE_EXPIRY_CRON,
    softInactiveCron: env.BUSINESS_SWEEP_SOFT_INACTIVE_CRON?.trim() || DEFAULT_SOFT_INACTIVE_CRON,
    systemEfficiencyCron: env.BUSINESS_SWEEP_SYSTEM_EFFICIENCY_CRON?.trim() || DEFAULT_SYSTEM_EFFICIENCY_CRON,
    fleetUptimeCron: env.BUSINESS_SWEEP_FLEET_UPTIME_CRON?.trim() || DEFAULT_FLEET_UPTIME_CRON,
    rootCauseCron: env.BUSINESS_SWEEP_ROOT_CAUSE_CRON?.trim() || DEFAULT_ROOT_CAUSE_CRON,
    zmPerformanceCron: env.BUSINESS_SWEEP_ZM_PERFORMANCE_CRON?.trim() || DEFAULT_ZM_PERFORMANCE_CRON,
    notificationOutboxCron: env.BUSINESS_SWEEP_NOTIFICATION_OUTBOX_CRON?.trim() || DEFAULT_NOTIFICATION_OUTBOX_CRON,
  };
}

/** What a manually-invokable cron handler reports — a tick NEVER throws out of a cron context. */
/**
 * `TICK_CLAIMED` (#263) is deliberately its own reason and deliberately not `ERROR`: another instance
 * won this window, the work IS being done, and G7 says a no-op is not a failure. It is also not
 * `RUN_IN_PROGRESS`, which means something quite different — that *this* process is still inside the
 * previous tick. Collapsing the two would make "we are running two instances, as designed" and "a
 * sweep is overrunning its cadence" indistinguishable in the one place an operator looks.
 */
export type SchedulerTickOutcome =
  | { ran: true }
  | { ran: false; reason: 'DISABLED' | 'RUN_IN_PROGRESS' | 'TICK_CLAIMED' | 'ERROR' };

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
 * (verification, the CRITICAL direct-assign sweep, cross-zone auto-escalation, install verification,
 * repeat escalation, the Issue 157 tier-override expiry sweep, and the report cubes). Mirrors
 * {@link IntegrationSchedulerService}: the master
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
    private readonly tierOverrideExpiry: TierOverrideExpiryService,
    private readonly softInactive: SoftInactiveCountService,
    private readonly fleetUptime: FleetUptimeAggregationService,
    private readonly rootCause: RootCauseAnalyticsAggregationService,
    private readonly zmPerformance: ZmPerformanceAggregationService,
    private readonly systemEfficiency: SystemEfficiencyAggregationService,
    private readonly claims: TickClaimant,
    config?: Partial<BusinessSweepSchedulerConfig>,
    // #264 — appended AFTER the pre-existing `config` param (rather than inserted before it)
    // deliberately: several specs construct this class positionally, ending the argument list at
    // `config`, and inserting earlier would silently shift their `config` object into a different
    // parameter instead of failing to compile. Both optional: a spec that never calls
    // `notificationOutboxTick` needs neither.
    private readonly prisma?: PrismaService,
    @Inject(DAY_PLAN_NOTIFIER) private readonly dayPlanNotifier?: DayPlanNotifier,
    // #338 — the generic half of the drain. Optional for the same reason as the two above: a spec
    // that hand-builds this class and never touches the outbox tick must not have to supply it.
    // Without it, NOTIFY rows are left un-claimed and retried rather than silently marked sent.
    @Optional() private readonly notifications?: NotificationService,
    // #338 — the two ports whose events the outbox now carries. Optional for the same reason, and
    // supplied by the same factory: a drain missing one un-claims the row rather than losing it.
    @Optional() @Inject(INSTALL_NOTIFIER) private readonly installNotifier?: InstallNotifier,
    @Optional() @Inject(RECOVERY_NOTIFIER) private readonly recoveryNotifier?: RecoveryNotifier,
  ) {
    this.config = { ...readBusinessSweepSchedulerConfig(), ...config };
  }

  /**
   * The uniform tick body: dormant-gate → single-in-flight guard → **tick claim** → run the sweep in a
   * try/catch → structured outcome. `name` is the registered cron-job name, and therefore the guard
   * key, the log label and the claim key all at once (#263 — see {@link BUSINESS_SWEEP_JOBS}).
   *
   * Eleven sweeps, one place. That is the point of putting the claim here rather than in the decorated
   * handlers: a twelfth sweep added to this class inherits cross-instance safety without its author
   * having to know the property exists, which is the only way a guarantee like this survives.
   *
   * **Order matters.** The dormant gate comes first so a disabled instance never writes a claim it has
   * no intention of honouring — a claim taken and abandoned would silence the instance that WOULD have
   * run. The in-flight guard comes next, so a process still inside its own previous tick does not spend
   * a database round trip to discover it. The claim comes last, immediately before the work.
   *
   * `claimTickOrLog` sits inside the try: a claim failure is a database failure, which is a genuine
   * ERROR and belongs in the same channel as a sweep that threw. A *refusal* is not — it returns false
   * and leaves through `TICK_CLAIMED`.
   */
  private async runGuarded(
    name: string,
    firedAt: Date,
    run: () => Promise<unknown>,
  ): Promise<SchedulerTickOutcome> {
    if (!this.config.enabled) return { ran: false, reason: 'DISABLED' };
    if (this.inFlight.has(name)) {
      this.logger.log(`${name} tick skipped — a run is already in flight`);
      return { ran: false, reason: 'RUN_IN_PROGRESS' };
    }
    this.inFlight.add(name);
    try {
      if (!(await this.claims.claimTickOrLog(name, firedAt))) return { ran: false, reason: 'TICK_CLAIMED' };
      await run();
      return { ran: true };
    } catch (e) {
      this.logger.error(`${name} tick failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ran: false, reason: 'ERROR' };
    } finally {
      this.inFlight.delete(name);
    }
  }

  @Cron(readBusinessSweepSchedulerConfig().verificationCron, { name: BUSINESS_SWEEP_JOBS.verification })
  verificationTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded(BUSINESS_SWEEP_JOBS.verification, now, () => this.verification.runVerification(now));
  }

  @Cron(readBusinessSweepSchedulerConfig().installVerificationCron, { name: BUSINESS_SWEEP_JOBS.installVerification })
  installVerificationTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded(BUSINESS_SWEEP_JOBS.installVerification, now, () => this.installLifecycle.runInstallVerification(now));
  }

  @Cron(readBusinessSweepSchedulerConfig().criticalAssignCron, { name: BUSINESS_SWEEP_JOBS.criticalAssign })
  criticalAssignTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    // #268 — renamed from `intradayTimeoutTick`: the offer/timeout machinery this drove is retired,
    // and the tick now direct-assigns CRITICAL/HIGH_CRITICAL tickets across every active zone.
    return this.runGuarded(BUSINESS_SWEEP_JOBS.criticalAssign, now, () => this.intraday.assignCriticalForActiveZones(now));
  }

  @Cron(readBusinessSweepSchedulerConfig().crossZoneCron, { name: BUSINESS_SWEEP_JOBS.crossZone })
  crossZoneTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded(BUSINESS_SWEEP_JOBS.crossZone, now, () => this.crossZone.sweepAutoEscalations(now));
  }

  @Cron(readBusinessSweepSchedulerConfig().repeatEscalationCron, { name: BUSINESS_SWEEP_JOBS.repeatEscalation })
  repeatEscalationTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded(BUSINESS_SWEEP_JOBS.repeatEscalation, now, () => this.repeatEscalation.runEscalationScan(now));
  }

  @Cron(readBusinessSweepSchedulerConfig().tierOverrideExpiryCron, { name: BUSINESS_SWEEP_JOBS.tierOverrideExpiry })
  tierOverrideExpiryTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded(BUSINESS_SWEEP_JOBS.tierOverrideExpiry, now, () => this.tierOverrideExpiry.sweepExpiredOverrides(now));
  }

  @Cron(readBusinessSweepSchedulerConfig().softInactiveCron, { name: BUSINESS_SWEEP_JOBS.softInactive })
  softInactiveTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded(BUSINESS_SWEEP_JOBS.softInactive, now, () => this.softInactive.recompute(now));
  }

  @Cron(readBusinessSweepSchedulerConfig().systemEfficiencyCron, { name: BUSINESS_SWEEP_JOBS.systemEfficiency })
  systemEfficiencyTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded(BUSINESS_SWEEP_JOBS.systemEfficiency, now, () => this.systemEfficiency.computeDay(previousUtcDayStart(now), now));
  }

  @Cron(readBusinessSweepSchedulerConfig().fleetUptimeCron, { name: BUSINESS_SWEEP_JOBS.fleetUptime })
  fleetUptimeTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded(BUSINESS_SWEEP_JOBS.fleetUptime, now, () => this.fleetUptime.computeMonth(previousUtcMonthStart(now), now));
  }

  @Cron(readBusinessSweepSchedulerConfig().rootCauseCron, { name: BUSINESS_SWEEP_JOBS.rootCause })
  rootCauseTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded(BUSINESS_SWEEP_JOBS.rootCause, now, () => this.rootCause.computeMonth(previousUtcMonthStart(now), now));
  }

  @Cron(readBusinessSweepSchedulerConfig().zmPerformanceCron, { name: BUSINESS_SWEEP_JOBS.zmPerformance })
  zmPerformanceTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded(BUSINESS_SWEEP_JOBS.zmPerformance, now, () => this.zmPerformance.computeMonth(previousUtcMonthStart(now), now));
  }

  // #264 — the day-plan notification outbox re-drain sweep: retries rows the immediate post-commit
  // drain missed (a crash between commit and drain) or lost the race on (a duplicate-drain conflict,
  // which resolves to exactly one delivery via `drainRow`'s guarded claim). Bounded `attempts`
  // (`MAX_OUTBOX_ATTEMPTS`) — an exhausted row stays visible via `lastError`, never retried forever.
  @Cron(readBusinessSweepSchedulerConfig().notificationOutboxCron, { name: BUSINESS_SWEEP_JOBS.notificationOutbox })
  notificationOutboxTick(now: Date = new Date()): Promise<SchedulerTickOutcome> {
    return this.runGuarded(BUSINESS_SWEEP_JOBS.notificationOutbox, now, () => {
      // `prisma`/`dayPlanNotifier` are optional constructor params (see the constructor's own
      // comment) — real wiring (`business-sweep-scheduler.module.ts`) always supplies both; a spec
      // that hand-builds this class without them and then calls this specific tick gets a clean ERROR
      // outcome from `runGuarded` rather than a crash.
      if (!this.prisma || !this.dayPlanNotifier) throw new Error('notification outbox sweep: prisma/dayPlanNotifier not wired');
      // #338 — this is the ONE drain that sees every producer's rows, so it is the one place that
      // must carry every deliverer. A missing one is not silent: the row is un-claimed with a
      // `last_error` naming which deliverer was absent.
      return drainUnsent(this.prisma, this.dayPlanNotifier, now, undefined, {
        notify: this.notifications,
        install: this.installNotifier,
        recovery: this.recoveryNotifier,
      });
    });
  }
}
