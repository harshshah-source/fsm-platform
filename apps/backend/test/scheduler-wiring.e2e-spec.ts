import type { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { IntegrationSyncService } from '../src/ingestion/autoplant/integration-sync.service';
import { PrismaService } from '../src/prisma/prisma.service';
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
  'business-fleet-uptime',
  'business-install-verification',
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

  it('registers exactly the 19 expected cron jobs — no more, no fewer', () => {
    const registered = [...app.get(SchedulerRegistry).getCronJobs().keys()].sort();

    expect(registered).toEqual(EXPECTED_CRON_JOBS);
    expect(registered).toHaveLength(19);
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
