import { vi } from 'vitest';
import { IntegrationSchedulerService } from '../src/ingestion/autoplant/integration-scheduler.service';
import type { IntegrationSyncService } from '../src/ingestion/autoplant/integration-sync.service';
import { PartitionMaintenanceService } from '../src/ingestion/partition-maintenance.service';
import { PlantEligibilityRefreshScheduler } from '../src/org/plant-eligibility-refresh-scheduler.service';
import type { PlantEligibleFloatingSeService } from '../src/org/plant-eligible-floating-se.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { SettingsService } from '../src/settings/settings.service';
import { BusinessSweepSchedulerService } from '../src/scheduling/business-sweep-scheduler.service';
import { CronTickClaimService } from '../src/scheduling/cron-tick-claim.service';
import { DispatchSchedulerService } from '../src/scheduling/dispatch-scheduler.service';
import type { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import { ScheduleClosureScheduler } from '../src/scheduling/schedule-closure-scheduler.service';
import { VehicleReturnResumeScheduler } from '../src/ticketing/vehicle-return-resume-scheduler.service';
import type { VehicleReturnResumeService } from '../src/ticketing/vehicle-return-resume.service';

/**
 * #263 AC-1 — **a second sweeps-enabled instance is a safe no-op.**
 *
 * The property under test is not "the claim table works" (that is `cron-tick-claims.e2e-spec.ts`); it
 * is that every scheduler in the app *consults* it, and does so in its shared single-flight wrapper
 * rather than in eighteen decorated handlers. So each of the seven wrappers is driven here as a pair
 * of independently constructed services over **two separate `PrismaService` connection pools** — the
 * closest a single test file gets to two instances — and the assertion is made on the **sweep's own
 * side effect**, not on the claim row: a wiring that claimed the window and then ran anyway would
 * satisfy a row count and fail this.
 *
 * G7 is asserted alongside every case: the loser reports `TICK_CLAIMED`, never `ERROR`. A no-op is not
 * a failure, and a scheduler that paged an operator every minute for behaving correctly would be worse
 * than the duplicate runs this issue removes.
 */
const NS = Date.now();
/** One window, asked for by both instances at different milliseconds — as two real clocks would. */
const FIRED_A = new Date('2026-08-23T05:00:03.000Z');
const FIRED_B = new Date('2026-08-23T05:00:41.577Z');

/** Every scheduler's collaborators, stubbed; one pair per instance so the spies cannot be confused. */
const sweepStubs = () => ({
  verification: { runVerification: vi.fn(async () => ({ closed: 0, failed: 0, fraud: 0, pending: 0 })) },
  intraday: { sweepTimeouts: vi.fn(async () => ({ timedOut: 0, rerouted: 0, escalated: 0 })) },
  crossZone: { sweepAutoEscalations: vi.fn(async () => ({ escalated: 0 })) },
  installLifecycle: { runInstallVerification: vi.fn(async () => ({ verified: 0, failed: 0, pending: 0 })) },
  repeatEscalation: { runEscalationScan: vi.fn(async () => ({ escalated: 0 })) },
  tierOverrideExpiry: { sweepExpiredOverrides: vi.fn(async () => ({ expired: 0 })) },
  softInactive: { recompute: vi.fn(async () => ({ capturedAt: FIRED_A.toISOString(), zones: 0 })) },
  fleetUptime: { computeMonth: vi.fn(async () => ({ month: '2026-07', devices: 0 })) },
  rootCause: { computeMonth: vi.fn(async () => ({ month: '2026-07', submissions: 0 })) },
  zmPerformance: { computeMonth: vi.fn(async () => ({ month: '2026-07', zms: 0 })) },
  systemEfficiency: { computeDay: vi.fn(async () => ({ day: '2026-08-22', rows: 0 })) },
});

const makeBusinessSweeps = (stubs: ReturnType<typeof sweepStubs>, claims: CronTickClaimService) =>
  new BusinessSweepSchedulerService(
    stubs.verification as never,
    stubs.intraday as never,
    stubs.crossZone as never,
    stubs.installLifecycle as never,
    stubs.repeatEscalation as never,
    stubs.tierOverrideExpiry as never,
    stubs.softInactive as never,
    stubs.fleetUptime as never,
    stubs.rootCause as never,
    stubs.zmPerformance as never,
    stubs.systemEfficiency as never,
    claims,
    { enabled: true },
  );

describe('#263 — every scheduler claims its tick window (e2e, two pools)', () => {
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let claimsA: CronTickClaimService;
  let claimsB: CronTickClaimService;

  beforeAll(async () => {
    prismaA = new PrismaService();
    await prismaA.onModuleInit();
    prismaB = new PrismaService();
    await prismaB.onModuleInit();
    claimsA = new CronTickClaimService(prismaA);
    claimsB = new CronTickClaimService(prismaB);
  });

  afterAll(async () => {
    await prismaA.onModuleDestroy();
    await prismaB.onModuleDestroy();
  });

  /**
   * Windows are per (job, minute) and every case below uses the SAME minute, so a stale row from a
   * previous run of this file would make a case pass vacuously (both instances refused). Clearing the
   * window before each test is what keeps a green run meaningful.
   */
  beforeEach(async () => {
    await prismaA.cronTickClaim.deleteMany({ where: { windowStart: new Date('2026-08-23T05:00:00.000Z') } });
  });

  afterAll(async () => {
    await prismaA.cronTickClaim.deleteMany({ where: { windowStart: new Date('2026-08-23T05:00:00.000Z') } });
  });

  describe('business sweeps — runGuarded, the wrapper all eleven share', () => {
    it('runs the verification sweep on one instance only; the other reports TICK_CLAIMED', async () => {
      const a = sweepStubs();
      const b = sweepStubs();

      const first = await makeBusinessSweeps(a, claimsA).verificationTick(FIRED_A);
      const second = await makeBusinessSweeps(b, claimsB).verificationTick(FIRED_B);

      expect(first).toEqual({ ran: true });
      expect(second).toEqual({ ran: false, reason: 'TICK_CLAIMED' });
      // The side effect, which is the actual claim of this issue.
      expect(a.verification.runVerification).toHaveBeenCalledTimes(1);
      expect(b.verification.runVerification).not.toHaveBeenCalled();
    });

    it('claims per job — a monthly cube and a 5-minute sweep firing in the same minute both run', async () => {
      const a = sweepStubs();
      const b = sweepStubs();

      expect(await makeBusinessSweeps(a, claimsA).verificationTick(FIRED_A)).toEqual({ ran: true });
      expect(await makeBusinessSweeps(b, claimsB).fleetUptimeTick(FIRED_B)).toEqual({ ran: true });

      expect(a.verification.runVerification).toHaveBeenCalledTimes(1);
      expect(b.fleetUptime.computeMonth).toHaveBeenCalledTimes(1);
    });

    it('lets the loser win the NEXT window — a refused instance is not a demoted one', async () => {
      const a = sweepStubs();
      const b = sweepStubs();
      await makeBusinessSweeps(a, claimsA).verificationTick(FIRED_A);

      const next = new Date('2026-08-23T05:05:00.000Z');
      await prismaA.cronTickClaim.deleteMany({ where: { windowStart: next } });
      expect(await makeBusinessSweeps(b, claimsB).verificationTick(next)).toEqual({ ran: true });
      await prismaA.cronTickClaim.deleteMany({ where: { windowStart: next } });

      expect(b.verification.runVerification).toHaveBeenCalledTimes(1);
    });

    it('does not claim a window it is not going to run — a DISABLED instance leaves the window free', async () => {
      const a = sweepStubs();
      const disabled = new BusinessSweepSchedulerService(
        a.verification as never,
        a.intraday as never,
        a.crossZone as never,
        a.installLifecycle as never,
        a.repeatEscalation as never,
        a.tierOverrideExpiry as never,
        a.softInactive as never,
        a.fleetUptime as never,
        a.rootCause as never,
        a.zmPerformance as never,
        a.systemEfficiency as never,
        claimsA,
        { enabled: false },
      );

      expect(await disabled.verificationTick(FIRED_A)).toEqual({ ran: false, reason: 'DISABLED' });

      const b = sweepStubs();
      expect(await makeBusinessSweeps(b, claimsB).verificationTick(FIRED_B)).toEqual({ ran: true });
      expect(b.verification.runVerification).toHaveBeenCalledTimes(1);
    });
  });

  describe('the six schedulers that keep their own single-flight wrapper', () => {
    it('dispatch tick: one instance runs the zones, the other no-ops', async () => {
      const runA = vi.fn(async () => ({ result: 'OK' }) as never);
      const runB = vi.fn(async () => ({ result: 'OK' }) as never);
      const svcA = new DispatchSchedulerService({ runForActiveZones: runA } as unknown as DispatchRunService, claimsA, {
        enabled: true,
      });
      const svcB = new DispatchSchedulerService({ runForActiveZones: runB } as unknown as DispatchRunService, claimsB, {
        enabled: true,
      });

      expect(await svcA.dispatchTick(FIRED_A)).toEqual({ ran: true });
      expect(await svcB.dispatchTick(FIRED_B)).toEqual({ ran: false, reason: 'TICK_CLAIMED' });
      expect(runA).toHaveBeenCalledTimes(1);
      expect(runB).not.toHaveBeenCalled();
    });

    it('dispatch reaper tick: claimed separately from the dispatch it accompanies', async () => {
      const reapA = vi.fn(async () => ({ runs: 0, claims: 0 }));
      const reapB = vi.fn(async () => ({ runs: 0, claims: 0 }));
      const dispatchA = vi.fn(async () => ({ result: 'OK' }) as never);
      const svcA = new DispatchSchedulerService(
        { reapStaleDispatchRuns: reapA, runForActiveZones: dispatchA } as unknown as DispatchRunService,
        claimsA,
        { enabled: true },
      );
      const svcB = new DispatchSchedulerService(
        { reapStaleDispatchRuns: reapB } as unknown as DispatchRunService,
        claimsB,
        { enabled: true },
      );

      // The dispatch tick in the same minute must not consume the reaper's window: they are two jobs.
      expect(await svcA.dispatchTick(FIRED_A)).toEqual({ ran: true });
      expect(await svcA.dispatchReaperTick(FIRED_A)).toEqual({ ran: true });
      expect(await svcB.dispatchReaperTick(FIRED_B)).toEqual({ ran: false, reason: 'TICK_CLAIMED' });
      expect(reapA).toHaveBeenCalledTimes(1);
      expect(reapB).not.toHaveBeenCalled();
    });

    it('schedule closure: one instance scans, the other never reaches the database', async () => {
      const svcA = new ScheduleClosureScheduler(prismaA, claimsA, { enabled: true });
      const svcB = new ScheduleClosureScheduler(prismaB, claimsB, { enabled: true });
      // Stubbed rather than passed through: a Prisma delegate accessed off the client is a fresh
      // object each time, so a bare `spyOn` records the call and then returns `undefined` to the
      // caller. `mockResolvedValue([])` is both the fix and the right fixture — "no stale schedules"
      // is the empty scan this assertion wants.
      const scanA = vi.spyOn(prismaA.workSchedule, 'findMany').mockResolvedValue([]);
      const scanB = vi.spyOn(prismaB.workSchedule, 'findMany').mockResolvedValue([]);

      const first = await svcA.closeTick({ now: FIRED_A });
      const second = await svcB.closeTick({ now: FIRED_B });

      expect(first).toEqual({ ran: true, closed: 0, zonesSkipped: 0, recycled: 0 });
      expect(second).toEqual({ ran: false, reason: 'TICK_CLAIMED' });
      expect(scanA).toHaveBeenCalledTimes(1);
      expect(scanB).not.toHaveBeenCalled();
      scanA.mockRestore();
      scanB.mockRestore();
    });

    it('plant-eligibility refresh: the MV is rebuilt once', async () => {
      const refreshA = vi.fn(async () => undefined);
      const refreshB = vi.fn(async () => undefined);
      const svcA = new PlantEligibilityRefreshScheduler(
        { refresh: refreshA } as unknown as PlantEligibleFloatingSeService,
        claimsA,
        { enabled: true },
      );
      const svcB = new PlantEligibilityRefreshScheduler(
        { refresh: refreshB } as unknown as PlantEligibleFloatingSeService,
        claimsB,
        { enabled: true },
      );

      expect(await svcA.refreshTick(FIRED_A)).toEqual({ ran: true });
      expect(await svcB.refreshTick(FIRED_B)).toEqual({ ran: false, reason: 'TICK_CLAIMED' });
      expect(refreshA).toHaveBeenCalledTimes(1);
      expect(refreshB).not.toHaveBeenCalled();
    });

    it('vehicle-return resume: an SLA clock is resumed once, not twice', async () => {
      const sweepA = vi.fn(async () => ({ resumed: 0 }));
      const sweepB = vi.fn(async () => ({ resumed: 0 }));
      const svcA = new VehicleReturnResumeScheduler(
        { sweepReturnedVehicles: sweepA } as unknown as VehicleReturnResumeService,
        claimsA,
        { enabled: true },
      );
      const svcB = new VehicleReturnResumeScheduler(
        { sweepReturnedVehicles: sweepB } as unknown as VehicleReturnResumeService,
        claimsB,
        { enabled: true },
      );

      expect(await svcA.resumeTick(FIRED_A)).toEqual({ ran: true });
      expect(await svcB.resumeTick(FIRED_B)).toEqual({ ran: false, reason: 'TICK_CLAIMED' });
      expect(sweepA).toHaveBeenCalledTimes(1);
      expect(sweepB).not.toHaveBeenCalled();
    });

    it('ingestion telemetry + masters: each claimed on its own job name', async () => {
      const syncA = {
        ingestTelemetry: vi.fn(async () => ({ skipped: false }) as never),
        syncMastersTick: vi.fn(async () => ({ skipped: false }) as never),
      };
      const syncB = {
        ingestTelemetry: vi.fn(async () => ({ skipped: false }) as never),
        syncMastersTick: vi.fn(async () => ({ skipped: false }) as never),
      };
      const gate = { isConfigured: () => true };
      const cfg = { enabled: true, mastersCron: '0 2 * * *', telemetryCron: '*/30 * * * *' };
      const svcA = new IntegrationSchedulerService(syncA as unknown as IntegrationSyncService, gate, claimsA, cfg);
      const svcB = new IntegrationSchedulerService(syncB as unknown as IntegrationSyncService, gate, claimsB, cfg);

      expect(await svcA.telemetryTick(FIRED_A)).toEqual({ ran: true });
      expect(await svcB.telemetryTick(FIRED_B)).toEqual({ ran: false, reason: 'TICK_CLAIMED' });
      // A different job in the same minute is a different window.
      expect(await svcB.mastersTick(FIRED_B)).toEqual({ ran: true });

      expect(syncA.ingestTelemetry).toHaveBeenCalledTimes(1);
      expect(syncB.ingestTelemetry).not.toHaveBeenCalled();
      expect(syncB.syncMastersTick).toHaveBeenCalledTimes(1);
    });

    it('partition maintenance: DDL runs on one instance only', async () => {
      const settings = { get: vi.fn(async () => 7) } as unknown as SettingsService;
      const svcA = new PartitionMaintenanceService(prismaA, settings, claimsA);
      const svcB = new PartitionMaintenanceService(prismaB, settings, claimsB);
      const runA = vi.spyOn(svcA, 'runMaintenance').mockResolvedValue({ retentionDays: 7, created: [], dropped: [] });
      const runB = vi.spyOn(svcB, 'runMaintenance').mockResolvedValue({ retentionDays: 7, created: [], dropped: [] });
      const prev = process.env.PARTITION_MAINTENANCE_ENABLED;
      process.env.PARTITION_MAINTENANCE_ENABLED = 'true';
      try {
        expect(await svcA.scheduledMaintenance(FIRED_A)).toEqual({ ran: true });
        expect(await svcB.scheduledMaintenance(FIRED_B)).toEqual({ ran: false, reason: 'TICK_CLAIMED' });
      } finally {
        if (prev === undefined) delete process.env.PARTITION_MAINTENANCE_ENABLED;
        else process.env.PARTITION_MAINTENANCE_ENABLED = prev;
      }

      expect(runA).toHaveBeenCalledTimes(1);
      expect(runB).not.toHaveBeenCalled();
    });
  });

  describe('AC-4 — the retention prune rides the partition-maintenance tick, adding no cron', () => {
    it('prunes expired claims after the maintenance it accompanies', async () => {
      const settings = { get: vi.fn(async () => 7) } as unknown as SettingsService;
      const svc = new PartitionMaintenanceService(prismaA, settings, claimsA);
      vi.spyOn(svc, 'runMaintenance').mockResolvedValue({ retentionDays: 7, created: [], dropped: [] });

      const stale = new Date(FIRED_A.getTime() - 30 * 24 * 60 * 60 * 1000);
      await prismaA.cronTickClaim.create({
        data: { jobName: `prune-probe-${NS}`, windowStart: stale, claimedBy: 'spec' },
      });

      const prev = process.env.PARTITION_MAINTENANCE_ENABLED;
      process.env.PARTITION_MAINTENANCE_ENABLED = 'true';
      try {
        expect(await svc.scheduledMaintenance(FIRED_A)).toEqual({ ran: true });
      } finally {
        if (prev === undefined) delete process.env.PARTITION_MAINTENANCE_ENABLED;
        else process.env.PARTITION_MAINTENANCE_ENABLED = prev;
      }

      expect(await prismaA.cronTickClaim.count({ where: { jobName: `prune-probe-${NS}` } })).toBe(0);
    });
  });
});
