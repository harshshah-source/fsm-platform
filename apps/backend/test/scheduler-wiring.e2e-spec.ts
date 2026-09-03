import type { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { IntegrationSyncService } from '../src/ingestion/autoplant/integration-sync.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { BusinessSweepSchedulerService } from '../src/scheduling/business-sweep-scheduler.service';
import { FleetUptimeAggregationService } from '../src/reports/fleet-uptime-aggregation.service';
import { RootCauseAnalyticsAggregationService } from '../src/reports/root-cause-aggregation.service';
import { ZmPerformanceAggregationService } from '../src/reports/zm-performance-aggregation.service';
import { AutoRecoveryService } from '../src/ticketing/auto-recovery.service';

/**
 * #229 AC-2 / #228 R4 — **"is this actually wired?" must be answerable mechanically.**
 *
 * #229 exists because `AutoRecoveryService.runAutoRecovery` was built, documented, tested and had no
 * production caller for eleven months. Nothing failed; 11,042 closable tickets simply accumulated.
 * The reason it stayed invisible is that the source of truth for "does this run?" was a prose doc
 * comment nobody re-derived — and #229 §4 found the *mirror image* of the same failure: nine comments
 * claiming "no scheduler / cron deferred" on services that #108 had already wired. Both directions of
 * the error are undetectable by reading code.
 *
 * So this spec asserts the two bindings against the **real `AppModule`**, not a hand-built fixture:
 *
 * 1. The full registered cron-job-name set. A `@Cron` decorator is evaluated once at class load, so a
 *    name-set assertion is the only mechanical check that can hold. Deliberately exact (`toEqual`, a
 *    sorted array) rather than a `toContain` per job: a superset check would not notice a job that
 *    silently stopped registering, which is the exact failure being guarded.
 * 2. The auto-recovery pre-check is genuinely reached by the telemetry pipeline — proven by spying on
 *    the container's own `AutoRecoveryService` and driving the container's own
 *    `IntegrationSyncService`, so DI wiring, stage order and the surfaced result are all covered.
 *
 * Adding a legitimate new cron means updating EXPECTED_CRON_JOBS in the same commit. That is the
 * point: the list is a decision record, and changing it should be deliberate and reviewed.
 */
const EXPECTED_CRON_JOBS = [
  // #268 — renamed from `business-intraday-timeout`: the offer/accept/timeout machinery it drove is
  // retired, and the tick now direct-assigns CRITICAL/HIGH_CRITICAL tickets across every active zone.
  'business-critical-assign',
  'business-cross-zone',
  'business-dispatch',
  // #261 — the reap sweep. Separate from `business-dispatch` on purpose: it frees the zones of runs
  // whose process died and deliberately dispatches nothing, so an idle system heals itself without an
  // unscheduled dispatch run appearing at an arbitrary minute of the day.
  'business-dispatch-reaper',
  // #286 — the same-day recovery collector (#282 R3). Separate from the reaper above for the reason
  // that one is separate from `business-dispatch`: the janitor records that a zone lost its day, this
  // one decides — bounded, and on the record — to give it back.
  'business-dispatch-recovery',
  'business-fleet-uptime',
  'business-install-verification',
  // #264 — the day-plan notification outbox re-drain sweep.
  'business-notification-outbox',
  // #361 — the two PRD notification events that have no mutation to hang off: the 7-day
  // waiting-component escalation (nothing happens on day seven — only a clock notices) and the
  // ingestion FAILED/overdue alert to the Operations Head (a stopped pipeline produces no runs to
  // hook, which was #348's whole finding). Both dedupe to one notice per entity per IST day, so the
  // hourly cadence sets only how promptly the first one goes out.
  'business-prd-event-notices',
  'business-repeat-escalation',
  'business-root-cause',
  'business-soft-inactive',
  'business-system-efficiency',
  'business-tier-override-expiry',
  'business-verification',
  'business-zm-performance',
  'ingestion-masters',
  'ingestion-telemetry',
  'partition-maintenance',
  'plant-eligibility-refresh',
  'schedule-closure',
  'vu-auto-resume',
];

describe('#229 AC-2 — scheduled-work wiring, asserted on the real AppModule', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdRunIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    // The @nestjs/schedule registry is populated during onApplicationBootstrap, which `init()` runs —
    // reading it before that would see an empty map and pass vacuously.
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (createdRunIds.length > 0) {
      await prisma.snapshotRunChunk.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.snapshotRun.deleteMany({ where: { runId: { in: createdRunIds } } });
    }
    await app.close();
  });

  it('registers exactly the 22 expected cron jobs — no more, no fewer', () => {
    const registered = [...app.get(SchedulerRegistry).getCronJobs().keys()].sort();

    expect(registered).toEqual(EXPECTED_CRON_JOBS);
    expect(registered).toHaveLength(22);
  });

  /**
   * #346 AC3 — **coverage, asserted on the clock and on the call.**
   *
   * The three monthly cubes were pinned to the 1st of the month (`0 3 1 * *`), so on every other day
   * of the month the current month had no row at all — and the report, asked for the current month by
   * default, answered `100` for it. Two separate bindings have to hold, and they fail independently:
   *
   *  1. the cron has to fire on *every* day, not only day-of-month 1 — read off the registry, which is
   *     what actually schedules the work, not off the default constant;
   *  2. a tick has to compute **both** months — the current one so today's report has a row, and the
   *     previous one so the month just ended is still finalised by the run on the 1st. Dropping the
   *     previous month would leave every completed month short of its last 21 hours.
   */
  describe('#346 — the monthly cubes cover the current month, daily', () => {
    const CUBE_JOBS = ['business-fleet-uptime', 'business-root-cause', 'business-zm-performance'];

    it('schedules each cube every day, not only on the 1st of the month', () => {
      const jobs = app.get(SchedulerRegistry).getCronJobs();
      for (const name of CUBE_JOBS) {
        const source = String(jobs.get(name)?.cronTime.source);
        const dayOfMonth = source.split(' ')[2];
        expect(source).toBeTruthy();
        // `0 3 1 * *` ran twelve times a year. A daily cadence leaves day-of-month unconstrained.
        expect(dayOfMonth).toBe('*');
      }
    });

    it('each cube tick computes the previous AND the current UTC month', async () => {
      const now = new Date('2026-07-14T03:00:00.000Z');
      const june = new Date(Date.UTC(2026, 5, 1));
      const july = new Date(Date.UTC(2026, 6, 1));

      const scheduler = app.get(BusinessSweepSchedulerService);
      const spies = {
        fleetUptime: vi.spyOn(app.get(FleetUptimeAggregationService), 'computeMonth').mockResolvedValue({ month: '2026-07-01', devices: 0 }),
        rootCause: vi.spyOn(app.get(RootCauseAnalyticsAggregationService), 'computeMonth').mockResolvedValue({ month: '2026-07-01', submissions: 0 }),
        zmPerformance: vi.spyOn(app.get(ZmPerformanceAggregationService), 'computeMonth').mockResolvedValue({ month: '2026-07-01', zms: 0 }),
      };
      // The container's own instance is dormant in test env (`BUSINESS_SWEEPS_ENABLED` unset), and the
      // dormant gate is the FIRST thing `runGuarded` checks — so drive the handler bodies directly.
      // This asserts the month arithmetic, not the gate; `business-sweep-scheduler.e2e-spec.ts` owns
      // the gate and `cron-tick-claim-wiring.e2e-spec.ts` owns the claim.
      const enabled = scheduler as unknown as { config: { enabled: boolean } };
      const wasEnabled = enabled.config.enabled;
      enabled.config.enabled = true;
      try {
        await scheduler.fleetUptimeTick(now);
        await scheduler.rootCauseTick(now);
        await scheduler.zmPerformanceTick(now);
      } finally {
        enabled.config.enabled = wasEnabled;
        await prisma.cronTickClaim.deleteMany({ where: { windowStart: new Date('2026-07-14T03:00:00.000Z') } });
      }

      for (const spy of Object.values(spies)) {
        expect(spy).toHaveBeenCalledWith(june, now);
        expect(spy).toHaveBeenCalledWith(july, now);
        expect(spy).toHaveBeenCalledTimes(2);
        spy.mockRestore();
      }
    });
  });

  it('reaches the auto-recovery pre-check from the telemetry tick, and surfaces its result', async () => {
    const autoRecovery = app.get(AutoRecoveryService);
    const sync = app.get(IntegrationSyncService);
    const spy = vi
      .spyOn(autoRecovery, 'runAutoRecovery')
      .mockResolvedValue({ closed: 0, scanned: 0, examined: 0, capped: false });

    const result = await sync.ingestTelemetry();
    if (!result.skipped) createdRunIds.push(BigInt(result.snapshot.runId));

    // The binding #229 found missing: a real caller, resolved through DI, not a test-only fixture.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    // A typed zero in the summary (#228 R3) — "ran and found nothing" must be distinguishable from
    // "never ran", which is precisely the signal this issue had no way to emit.
    expect(result.recovered).toEqual({ closed: 0, scanned: 0, examined: 0, capped: false });

    spy.mockRestore();
  });
});
