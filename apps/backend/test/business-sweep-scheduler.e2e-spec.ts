import { alwaysClaims } from './support/tick-claims';
import { vi } from 'vitest';
import type { CrossZoneEscalationService } from '../src/cross-zone/cross-zone-escalation.service';
import type { IntradayInsertionService } from '../src/intraday/intraday-insertion.service';
import type { FleetUptimeAggregationService } from '../src/reports/fleet-uptime-aggregation.service';
import type { RootCauseAnalyticsAggregationService } from '../src/reports/root-cause-aggregation.service';
import type { SoftInactiveCountService } from '../src/reports/soft-inactive-count.service';
import type { SystemEfficiencyAggregationService } from '../src/reports/system-efficiency-aggregation.service';
import type { ZmPerformanceAggregationService } from '../src/reports/zm-performance-aggregation.service';
import type { TierOverrideExpiryService } from '../src/org/tier-override-expiry.service';
import type { InstallLifecycleService } from '../src/ticketing/install-lifecycle.service';
import type { RepeatEscalationService } from '../src/ticketing/repeat-escalation.service';
import type { VerificationService } from '../src/verification/verification.service';
import {
  BusinessSweepSchedulerService,
  DEFAULT_CROSS_ZONE_CRON,
  DEFAULT_FLEET_UPTIME_CRON,
  DEFAULT_INSTALL_VERIFICATION_CRON,
  DEFAULT_CRITICAL_ASSIGN_CRON,
  DEFAULT_NOTIFICATION_OUTBOX_CRON,
  DEFAULT_REPEAT_ESCALATION_CRON,
  DEFAULT_ROOT_CAUSE_CRON,
  DEFAULT_SOFT_INACTIVE_CRON,
  DEFAULT_SYSTEM_EFFICIENCY_CRON,
  DEFAULT_TIER_OVERRIDE_EXPIRY_CRON,
  DEFAULT_VERIFICATION_CRON,
  DEFAULT_ZM_PERFORMANCE_CRON,
  readBusinessSweepSchedulerConfig,
} from '../src/scheduling/business-sweep-scheduler.service';

/**
 * Issue 108 — BusinessSweepSchedulerService. The business-facing periodic loops (verification,
 * the CRITICAL direct-assign sweep, cross-zone auto-escalation, install verification, repeat escalation,
 * and the report cubes) shipped as on-demand HTTP-triggered workers with "cron deferred". This
 * scheduler mirrors IntegrationSchedulerService (Issue 97): env-gated master switch
 * (`BUSINESS_SWEEPS_ENABLED`, default OFF), one `@Cron` handler per sweep, a tick that NEVER throws
 * out of the cron context, and a per-sweep single-in-flight guard (the sweeps have no guard of their
 * own). No external-source gate — the sweeps run against the local DB, so the only dormant reason is
 * DISABLED. Handlers are driven directly here; the cron trigger itself is the library's concern.
 */

/** All 11 sweep collaborators as vi.fn() stubs — every method returns a benign shape. */
const makeSweeps = () => ({
  verification: { runVerification: vi.fn(async () => ({ closed: 0, failed: 0, fraud: 0, pending: 0 })) },
  intraday: { assignCriticalForActiveZones: vi.fn(async () => ({ assigned: 0, escalated: 0 })) },
  crossZone: { sweepAutoEscalations: vi.fn(async () => ({ escalated: 0 })) },
  installLifecycle: { runInstallVerification: vi.fn(async () => ({ verified: 0, failed: 0, pending: 0 })) },
  repeatEscalation: { runEscalationScan: vi.fn(async () => ({ escalated: 0 })) },
  tierOverrideExpiry: { sweepExpiredOverrides: vi.fn(async () => ({ expired: 0 })) },
  softInactive: { recompute: vi.fn(async () => ({ capturedAt: '2026-07-07T00:00:00.000Z', zones: 0 })) },
  fleetUptime: { computeMonth: vi.fn(async () => ({ month: '2026-07', devices: 0 })) },
  rootCause: { computeMonth: vi.fn(async () => ({ month: '2026-07', submissions: 0 })) },
  zmPerformance: { computeMonth: vi.fn(async () => ({ month: '2026-07', zms: 0 })) },
  systemEfficiency: { computeDay: vi.fn(async () => ({ day: '2026-07-07', rows: 0 })) },
});

type Sweeps = ReturnType<typeof makeSweeps>;

const makeScheduler = (sweeps: Sweeps, enabled: boolean): BusinessSweepSchedulerService =>
  new BusinessSweepSchedulerService(
    sweeps.verification as unknown as VerificationService,
    sweeps.intraday as unknown as IntradayInsertionService,
    sweeps.crossZone as unknown as CrossZoneEscalationService,
    sweeps.installLifecycle as unknown as InstallLifecycleService,
    sweeps.repeatEscalation as unknown as RepeatEscalationService,
    sweeps.tierOverrideExpiry as unknown as TierOverrideExpiryService,
    sweeps.softInactive as unknown as SoftInactiveCountService,
    sweeps.fleetUptime as unknown as FleetUptimeAggregationService,
    sweeps.rootCause as unknown as RootCauseAnalyticsAggregationService,
    sweeps.zmPerformance as unknown as ZmPerformanceAggregationService,
    sweeps.systemEfficiency as unknown as SystemEfficiencyAggregationService,
    alwaysClaims(),
    { enabled },
  );

describe('Issue 108 — BusinessSweepSchedulerService (config + guarded runner)', () => {
  describe('readBusinessSweepSchedulerConfig', () => {
    it('is OFF by default and resolves every cron to its documented default', () => {
      expect(readBusinessSweepSchedulerConfig({})).toEqual({
        enabled: false,
        verificationCron: DEFAULT_VERIFICATION_CRON,
        installVerificationCron: DEFAULT_INSTALL_VERIFICATION_CRON,
        criticalAssignCron: DEFAULT_CRITICAL_ASSIGN_CRON,
        crossZoneCron: DEFAULT_CROSS_ZONE_CRON,
        repeatEscalationCron: DEFAULT_REPEAT_ESCALATION_CRON,
        tierOverrideExpiryCron: DEFAULT_TIER_OVERRIDE_EXPIRY_CRON,
        softInactiveCron: DEFAULT_SOFT_INACTIVE_CRON,
        systemEfficiencyCron: DEFAULT_SYSTEM_EFFICIENCY_CRON,
        fleetUptimeCron: DEFAULT_FLEET_UPTIME_CRON,
        rootCauseCron: DEFAULT_ROOT_CAUSE_CRON,
        zmPerformanceCron: DEFAULT_ZM_PERFORMANCE_CRON,
        notificationOutboxCron: DEFAULT_NOTIFICATION_OUTBOX_CRON,
      });
    });

    it('enables only on the literal string "true" — any other value stays OFF (deliberate ops step)', () => {
      expect(readBusinessSweepSchedulerConfig({ BUSINESS_SWEEPS_ENABLED: 'true' }).enabled).toBe(true);
      expect(readBusinessSweepSchedulerConfig({ BUSINESS_SWEEPS_ENABLED: '1' }).enabled).toBe(false);
      expect(readBusinessSweepSchedulerConfig({ BUSINESS_SWEEPS_ENABLED: 'TRUE' }).enabled).toBe(false);
    });

    it('every cron is env-overridable', () => {
      const cfg = readBusinessSweepSchedulerConfig({
        BUSINESS_SWEEP_VERIFICATION_CRON: '*/7 * * * *',
        BUSINESS_SWEEP_CRITICAL_ASSIGN_CRON: '*/3 * * * *',
        BUSINESS_SWEEP_FLEET_UPTIME_CRON: '0 4 2 * *',
      });
      expect(cfg.verificationCron).toBe('*/7 * * * *');
      expect(cfg.criticalAssignCron).toBe('*/3 * * * *');
      expect(cfg.fleetUptimeCron).toBe('0 4 2 * *');
      // untouched keys keep their defaults
      expect(cfg.crossZoneCron).toBe(DEFAULT_CROSS_ZONE_CRON);
    });
  });

  describe('verificationTick (representative guarded runner)', () => {
    let sweeps: Sweeps;
    beforeEach(() => {
      sweeps = makeSweeps();
    });

    it('dispatches to runVerification with the tick clock when enabled', async () => {
      const now = new Date('2026-07-07T09:00:00.000Z');
      const outcome = await makeScheduler(sweeps, true).verificationTick(now);

      expect(sweeps.verification.runVerification).toHaveBeenCalledTimes(1);
      expect(sweeps.verification.runVerification).toHaveBeenCalledWith(now);
      expect(outcome).toEqual({ ran: true });
    });

    it('is a dormant no-op when the master switch is off — no dispatch (default posture)', async () => {
      const outcome = await makeScheduler(sweeps, false).verificationTick();

      expect(sweeps.verification.runVerification).not.toHaveBeenCalled();
      expect(outcome).toEqual({ ran: false, reason: 'DISABLED' });
    });

    it('#181 AC-6 — the explicit config argument wins over the ambient env, in both directions', async () => {
      // Regression for the arity drift: config used to land on the wrong parameter and silently
      // fall back to process.env.BUSINESS_SWEEPS_ENABLED. Flip the ambient value opposite to the
      // explicit `enabled` argument in each direction and assert the argument wins every time.
      const prior = process.env.BUSINESS_SWEEPS_ENABLED;
      try {
        process.env.BUSINESS_SWEEPS_ENABLED = 'true';
        expect(await makeScheduler(sweeps, false).verificationTick()).toEqual({ ran: false, reason: 'DISABLED' });
        expect(sweeps.verification.runVerification).not.toHaveBeenCalled();

        process.env.BUSINESS_SWEEPS_ENABLED = 'false';
        expect(await makeScheduler(sweeps, true).verificationTick()).toEqual({ ran: true });
        expect(sweeps.verification.runVerification).toHaveBeenCalledTimes(1);
      } finally {
        if (prior === undefined) delete process.env.BUSINESS_SWEEPS_ENABLED;
        else process.env.BUSINESS_SWEEPS_ENABLED = prior;
      }
    });

    it('a throwing sweep never escapes the cron context — logged and reported as ERROR', async () => {
      sweeps.verification.runVerification.mockRejectedValueOnce(new Error('boom') as never);
      const outcome = await makeScheduler(sweeps, true).verificationTick();

      expect(outcome).toEqual({ ran: false, reason: 'ERROR' });
    });

    it('single-in-flight guard is per-sweep — a busy verification tick does not block a sibling tick', async () => {
      let release!: () => void;
      sweeps.verification.runVerification.mockImplementationOnce(
        () => new Promise((res) => { release = () => res({ closed: 0, failed: 0, fraud: 0, pending: 0 } as never); }),
      );
      const scheduler = makeScheduler(sweeps, true);

      const heldVerification = scheduler.verificationTick();
      // A different sweep (cross-zone) must still run while verification is held.
      expect(await scheduler.crossZoneTick()).toEqual({ ran: true });
      expect(sweeps.crossZone.sweepAutoEscalations).toHaveBeenCalledTimes(1);

      release();
      expect(await heldVerification).toEqual({ ran: true });
    });

    it('single-in-flight guard: an overlapping tick skips with RUN_IN_PROGRESS instead of double-running', async () => {
      // Hold the first run open until we release it, so the second tick genuinely overlaps.
      let release!: () => void;
      sweeps.verification.runVerification.mockImplementationOnce(
        () => new Promise((res) => { release = () => res({ closed: 0, failed: 0, fraud: 0, pending: 0 } as never); }),
      );
      const scheduler = makeScheduler(sweeps, true);

      const first = scheduler.verificationTick();
      const second = await scheduler.verificationTick(); // fires while `first` is still open

      expect(second).toEqual({ ran: false, reason: 'RUN_IN_PROGRESS' });
      expect(sweeps.verification.runVerification).toHaveBeenCalledTimes(1);

      release();
      expect(await first).toEqual({ ran: true });

      // After the first completes the guard is released — a later tick runs again.
      expect(await scheduler.verificationTick()).toEqual({ ran: true });
      expect(sweeps.verification.runVerification).toHaveBeenCalledTimes(2);
    });
  });

  describe('every sweep is wired to its tick with the right clock/period', () => {
    let sweeps: Sweeps;
    let scheduler: BusinessSweepSchedulerService;
    beforeEach(() => {
      sweeps = makeSweeps();
      scheduler = makeScheduler(sweeps, true);
    });

    it('minutes/quarter-hour sweeps receive the tick clock verbatim', async () => {
      const now = new Date('2026-07-07T09:13:00.000Z');
      await scheduler.installVerificationTick(now);
      await scheduler.crossZoneTick(now);
      await scheduler.repeatEscalationTick(now);
      await scheduler.softInactiveTick(now);

      expect(sweeps.installLifecycle.runInstallVerification).toHaveBeenCalledWith(now);
      expect(sweeps.crossZone.sweepAutoEscalations).toHaveBeenCalledWith(now);
      expect(sweeps.repeatEscalation.runEscalationScan).toHaveBeenCalledWith(now);
      expect(sweeps.softInactive.recompute).toHaveBeenCalledWith(now);
    });

    it('the daily system-efficiency tick finalises the PREVIOUS UTC day', async () => {
      await scheduler.systemEfficiencyTick(new Date('2026-07-07T01:30:00.000Z'));
      // Independent source of truth: July 7 → finalise July 6 (UTC midnight).
      expect(sweeps.systemEfficiency.computeDay).toHaveBeenCalledWith(
        new Date(Date.UTC(2026, 6, 6)),
        new Date('2026-07-07T01:30:00.000Z'),
      );
    });

    it('the month-start cubes finalise the PREVIOUS UTC month', async () => {
      const now = new Date('2026-07-01T03:00:00.000Z');
      await scheduler.fleetUptimeTick(now);
      await scheduler.rootCauseTick(now);
      await scheduler.zmPerformanceTick(now);
      // July 1 → finalise June (UTC month-start).
      const june = new Date(Date.UTC(2026, 5, 1));
      expect(sweeps.fleetUptime.computeMonth).toHaveBeenCalledWith(june, now);
      expect(sweeps.rootCause.computeMonth).toHaveBeenCalledWith(june, now);
      expect(sweeps.zmPerformance.computeMonth).toHaveBeenCalledWith(june, now);
    });

    it('crossing a year boundary: Jan 1 finalises the previous December', async () => {
      const now = new Date('2027-01-01T03:00:00.000Z');
      await scheduler.fleetUptimeTick(now);
      expect(sweeps.fleetUptime.computeMonth).toHaveBeenCalledWith(new Date(Date.UTC(2026, 11, 1)), now);
    });
  });

  describe('cron registration (AC#4 — every sweep is on the clock, dormant by default)', () => {
    it('registers all twelve named business-sweep cron jobs under ScheduleModule', async () => {
      const { Test } = await import('@nestjs/testing');
      const { ScheduleModule, SchedulerRegistry } = await import('@nestjs/schedule');

      const moduleRef = await Test.createTestingModule({
        imports: [ScheduleModule.forRoot()],
        providers: [
          { provide: BusinessSweepSchedulerService, useFactory: () => makeScheduler(makeSweeps(), false) },
        ],
      }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      try {
        const jobs = app.get(SchedulerRegistry).getCronJobs();
        for (const name of [
          'business-verification',
          'business-install-verification',
          'business-critical-assign',
          'business-cross-zone',
          'business-repeat-escalation',
          'business-tier-override-expiry',
          'business-soft-inactive',
          'business-system-efficiency',
          'business-fleet-uptime',
          'business-root-cause',
          'business-zm-performance',
          'business-notification-outbox',
        ]) {
          expect(jobs.has(name)).toBe(true);
        }
      } finally {
        await app.close();
      }
    });
  });
});
