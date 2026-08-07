import { AutoPlantHealthService, readLifecycleQuietRuns, type AutoPlantProbe } from '../src/ingestion/autoplant/health.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 218a — the deployment-lifecycle contradiction check.
 *
 * The gap this pins: `vehicles.status` (verbatim last-observed source status) and
 * `device_states.is_departed` (derived from the `device_departures` ledger) are written from the same
 * master-sync read and therefore cannot legitimately disagree. When the lifecycle pass silently stops
 * running, they drift apart — and every existing dashboard identity keeps balancing, because the
 * operational and warehouse counts move together. Only a comparison BETWEEN the two catches it.
 * Measured on production data 2026-08-07: 5,134 contradicting devices, 27 consecutive quiet syncs.
 *
 * No assertion here depends on rows other specs left behind — the failure mode #215 records. Two
 * different techniques, because the two metrics need different ones:
 *  - `drift` / `missingFromSource` assert a **delta** against a baseline read at the top of the test.
 *  - `quietRuns` asserts an absolute, but seeds a run that MOVED a device first. That run resets the
 *    consecutive count, so it acts as a barrier: every older run — including any other spec's — is
 *    excluded from the count by construction, and the absolute is safe. (`fileParallelism: false`
 *    additionally rules out a run being inserted concurrently mid-test.)
 */
const probe: AutoPlantProbe = { isConfigured: () => false, ping: async () => ({ ok: true, vehicleRows: 0 }) };

describe('Issue 218a — lifecycle contradiction check', () => {
  let prisma: PrismaService;
  let service: AutoPlantHealthService;

  const NS = Date.now() % 100_000;
  const V = (s: string) => `ZZ218${s}${NS}`;
  const D = (s: string) => `RR_D218${s}${NS}`;
  // agree-operational, agree-departed, contradicting, contradicting-but-excluded
  const DEVICES = [D('OK'), D('DEP'), D('DRIFT'), D('ABSENT')];
  const VEHICLES = [V('OK'), V('DEP'), V('DRIFT'), V('ABSENT')];

  let companyId: bigint;
  let plantId: bigint;
  let zoneId: bigint;
  const runIds: bigint[] = [];

  const cleanup = async (): Promise<void> => {
    await prisma.deviceDeparture.deleteMany({ where: { deviceId: { in: DEVICES } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: DEVICES } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: DEVICES } } });
    await prisma.vehicle.deleteMany({ where: { vehicleNo: { in: VEHICLES } } });
    if (runIds.length > 0) {
      await prisma.masterSyncRun.deleteMany({ where: { runId: { in: runIds } } });
      runIds.length = 0;
    }
  };

  /** One device + its vehicle, with the source status and derived flag set independently. */
  const seed = async (deviceId: string, vehicleNo: string, status: string, isDeparted: boolean): Promise<void> => {
    const vehicle = await prisma.vehicle.create({ data: { vehicleNo, plantId, companyId, status } });
    await prisma.device.create({ data: { deviceId, currentVehicleId: vehicle.vehicleId } });
    await prisma.deviceState.create({
      data: { deviceId, vehicleId: vehicle.vehicleId, plantId, companyId, isDeparted, computedAt: new Date() },
    });
  };

  const openDeparture = (deviceId: string, reason: string) =>
    prisma.deviceDeparture.create({
      data: { deviceId, observedStatus: reason === 'ABSENT_FROM_READ' ? 'MISSING_FROM_SOURCE' : 'UNDEPLOYED', reason },
    });

  /** A finished master sync whose lifecycle pass moved `inserted`/`updated` devices. */
  const syncRun = async (inserted: number, updated: number): Promise<void> => {
    const run = await prisma.masterSyncRun.create({
      data: {
        status: 'SUCCESS',
        finishedAt: new Date(),
        entityStats: { departures: { skipped: 0, inserted, updated } },
      },
    });
    runIds.push(run.runId);
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new AutoPlantHealthService(prisma, probe);
    zoneId = (await prisma.zone.create({ data: { name: `Z218_${NS}_${Date.now()}` } })).zoneId;
    companyId = (
      await prisma.company.create({
        data: { name: `Lifecycle Co ${NS}`, companyTier: 'SILVER', companyPriorityRank: 'P3' },
      })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: `Lifecycle Plant ${NS}`, zoneId } })).plantId;
    await cleanup();
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('counts a device whose source status contradicts its departure flag, and ignores agreeing ones', async () => {
    const before = await service.lifecycleHealth();

    // Agreeing pair: neither may move the counter.
    await seed(D('OK'), V('OK'), 'DEPLOYED', false);
    await seed(D('DEP'), V('DEP'), 'UNDEPLOYED', true);
    await openDeparture(D('DEP'), 'SOURCE_STATUS');
    expect((await service.lifecycleHealth()).drift).toBe(before.drift);

    // The contradiction: source says DEPLOYED, FSM has it in the warehouse.
    await seed(D('DRIFT'), V('DRIFT'), 'DEPLOYED', true);
    await openDeparture(D('DRIFT'), 'SOURCE_STATUS');
    expect((await service.lifecycleHealth()).drift).toBe(before.drift + 1);
  });

  it('excludes ABSENT_FROM_READ departures from drift and counts them separately', async () => {
    const before = await service.lifecycleHealth();

    // Same contradiction shape as above, but the source row is gone — the mirror is frozen BY DESIGN,
    // so this must not be reported as a defect the fix can clear.
    await seed(D('ABSENT'), V('ABSENT'), 'DEPLOYED', true);
    await openDeparture(D('ABSENT'), 'ABSENT_FROM_READ');

    const after = await service.lifecycleHealth();
    expect(after.drift).toBe(before.drift);
    expect(after.missingFromSource).toBe(before.missingFromSource + 1);
  });

  it('counts consecutive quiet syncs, and resets once a run moves a device', async () => {
    // A run that actually did lifecycle work resets the counter to zero…
    await syncRun(3, 1);
    expect((await service.lifecycleHealth()).quietRuns).toBe(0);

    // …and each subsequent do-nothing run advances it. This is the signal that sat unread in
    // entity_stats.departures for 33 runs while the pass was dead.
    await syncRun(0, 0);
    await syncRun(0, 0);
    expect((await service.lifecycleHealth()).quietRuns).toBe(2);
  });

  it('raises quietRunsAlert only past the threshold, and folds both signals into `healthy`', async () => {
    const threshold = readLifecycleQuietRuns();
    await syncRun(1, 0);
    for (let i = 0; i < threshold; i++) await syncRun(0, 0);

    const atThreshold = await service.lifecycleHealth();
    expect(atThreshold.quietRuns).toBe(threshold);
    expect(atThreshold.quietRunsAlert).toBe(false);

    await syncRun(0, 0);
    const past = await service.lifecycleHealth();
    expect(past.quietRunsAlert).toBe(true);
    expect(past.healthy).toBe(false);
  });

  it('is reported by check() and needs no AutoPlant connection', async () => {
    const health = await service.check();
    // The probe is unconfigured, so the source-vs-FSM reconciliation cannot be evaluated…
    expect(health.reconciliation.reconciled).toBeNull();
    // …while the lifecycle check, being pure Postgres, still is. That asymmetry is the point.
    expect(health.lifecycle).toMatchObject({
      drift: expect.any(Number),
      missingFromSource: expect.any(Number),
      quietRuns: expect.any(Number),
      quietRunsAlert: expect.any(Boolean),
      healthy: expect.any(Boolean),
    });
  });
});
