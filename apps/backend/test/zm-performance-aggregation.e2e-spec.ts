import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ZmPerformanceAggregationService } from '../src/reports/zm-performance-aggregation.service';

/**
 * Issue 43 slice 1 — the ZM Performance Scorecard aggregation worker. `computeMonth(month, now)` rebuilds
 * `zm_performance_summary_monthly`: one row per (month, zone, ZM user) holding that ZM's audited
 * decision-activity counts (overrides + by type, override-after-ON_SITE, manual assignments), the zone's
 * auto-assignment denominator, and the zone's Fleet-Uptime inputs (for zone SLA compliance). Only native
 * ZM actions count (`actor_role = ZONAL_MANAGER`); every ZM user is represented (zero-filled). Idempotent.
 */
const NS = Date.now();
const MAY = new Date(Date.UTC(2026, 4, 1));
const MAY_SECONDS = 31 * 86_400;
const NOW = new Date(Date.UTC(2026, 5, 26, 12, 0, 0));

describe('Issue 43 slice 1 — ZmPerformanceAggregationService.computeMonth', () => {
  let prisma: PrismaService;
  let service: ZmPerformanceAggregationService;

  let zoneA: bigint;
  let zoneB: bigint;
  let zmA: string;
  let zmB: string;
  let companyId: bigint;
  let plantA: bigint;
  let seId: string;
  const userIds: string[] = [];
  const scheduleIds: bigint[] = [];
  const batchIds: bigint[] = [];
  const auditIds: bigint[] = [];
  const devices: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new ZmPerformanceAggregationService(prisma);

    zoneA = (await prisma.zone.create({ data: { name: 'ZA-zps-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'ZB-zps-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-zps-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'PA-zps-' + NS, zoneId: zoneA } })).plantId;
    zmA = await makeUser('ZONAL_MANAGER', zoneA);
    zmB = await makeUser('ZONAL_MANAGER', zoneB);
    seId = await makeEngineer(zoneA);
  });

  afterAll(async () => {
    await prisma.zmPerformanceSummaryMonthly.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.auditLog.deleteMany({ where: { id: { in: auditIds } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.workSchedule.deleteMany({ where: { scheduleId: { in: scheduleIds } } });
    await prisma.deviceDowntimeSummaryMonthly.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: plantA } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  async function makeUser(role: 'ZONAL_MANAGER', zoneId: bigint): Promise<string> {
    const t = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: `${role} ${t}`, role, phone: `zps-${t}`, email: `zps-${t}@zps.test`, zoneId } });
    userIds.push(u.userId);
    return u.userId;
  }

  async function makeEngineer(zoneId: bigint): Promise<string> {
    const id = await makeUser('ZONAL_MANAGER', zoneId); // role irrelevant for the FK; reuse the user factory
    await prisma.engineerMaster.create({ data: { engineerId: id, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    return id;
  }

  async function audit(actorId: string, action: string, createdAt: Date, actorRole = 'ZONAL_MANAGER'): Promise<void> {
    const row = await prisma.auditLog.create({
      data: { actorId, actorRole, action, entityType: 'plant_batch_assignment', entityId: String(NS), createdAt },
    });
    auditIds.push(row.id);
  }

  async function autoBatch(createdAt: Date): Promise<void> {
    const sched = await prisma.workSchedule.create({
      data: { seId, zoneId: zoneA, dateFrom: MAY, dateTo: MAY, status: 'ACTIVE', source: 'SYSTEM_GENERATED', createdAt },
    });
    scheduleIds.push(sched.scheduleId);
    const b = await prisma.plantBatchAssignment.create({
      data: { scheduleId: sched.scheduleId, plantId: plantA, seId, status: 'AUTO_ASSIGNED', stopSequence: 1, createdAt },
    });
    batchIds.push(b.batchId);
  }

  async function downtimeRow(downtime: number): Promise<void> {
    const deviceId = BigInt(9_430_000 + devices.length + (NS % 1000));
    devices.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceDowntimeSummaryMonthly.create({
      data: { deviceId, month: MAY, zoneId: zoneA, companyId, plantId: plantA, eligible: true, windowSeconds: BigInt(MAY_SECONDS), downtimeSeconds: BigInt(downtime), computedAt: NOW },
    });
  }

  const rowFor = (zmId: string) => prisma.zmPerformanceSummaryMonthly.findFirst({ where: { zmId, month: MAY } });

  it('pivots a ZM’s audited decision actions into per-type counts and an overrides total', async () => {
    const may5 = new Date(Date.UTC(2026, 4, 5));
    await audit(zmA, 'BATCH_OVERRIDE_REMOVE_TICKET', may5);
    await audit(zmA, 'BATCH_OVERRIDE_REMOVE_TICKET', may5);
    await audit(zmA, 'BATCH_OVERRIDE_DEFER_TICKET', may5);
    await audit(zmA, 'BATCH_OVERRIDE_REASSIGN', may5);
    await audit(zmA, 'BATCH_OVERRIDE_SPLIT_BATCH', may5);
    await audit(zmA, 'OVERRIDE_AFTER_ON_SITE', may5);
    await audit(zmA, 'CRITICAL_ASSIGN', may5);
    await audit(zmA, 'MANUAL_ZM_UPDATE', may5);
    // excluded: an action in April, and a non-ZM actor in May
    await audit(zmA, 'BATCH_OVERRIDE_REMOVE_TICKET', new Date(Date.UTC(2026, 3, 28)));
    await audit(zmA, 'BATCH_OVERRIDE_REMOVE_TICKET', may5, 'CENTRAL_SERVICE_MANAGER');

    await service.computeMonth(MAY, NOW);

    const r = await rowFor(zmA);
    expect(r?.removals).toBe(2);
    expect(r?.deferrals).toBe(1);
    expect(r?.reassignments).toBe(1);
    expect(r?.splitBatches).toBe(1);
    expect(r?.overridesTotal).toBe(5); // remove×2 + defer + reassign + split (OVERRIDE_AFTER_ON_SITE is its own metric)
    expect(r?.overrideAfterOnsite).toBe(1);
    expect(r?.manualAssignments).toBe(2); // CRITICAL_ASSIGN + MANUAL_ZM_UPDATE
  });

  it('records the zone auto-assignment denominator and zone SLA inputs', async () => {
    await autoBatch(new Date(Date.UTC(2026, 4, 6)));
    await autoBatch(new Date(Date.UTC(2026, 4, 7)));
    await downtimeRow(86_400); // 1 day down
    await downtimeRow(0);

    await service.computeMonth(MAY, NOW);

    const r = await rowFor(zmA);
    expect(r?.autoAssignedCount).toBe(2);
    expect(r?.zoneEligibleDevices).toBe(2);
    expect(Number(r?.zoneDowntimeSeconds)).toBe(86_400);
    expect(Number(r?.zoneWindowSeconds)).toBe(2 * MAY_SECONDS);
  });

  it('zero-fills a ZM with no activity (complete comparison)', async () => {
    await service.computeMonth(MAY, NOW);
    const r = await rowFor(zmB);
    expect(r).toBeTruthy();
    expect(r?.overridesTotal).toBe(0);
    expect(r?.manualAssignments).toBe(0);
    expect(r?.zoneId).toBe(zoneB);
  });

  it('is idempotent — recomputing rebuilds without duplicating rows', async () => {
    await service.computeMonth(MAY, NOW);
    await service.computeMonth(MAY, NOW);
    const rows = await prisma.zmPerformanceSummaryMonthly.findMany({ where: { zmId: zmA, month: MAY } });
    expect(rows).toHaveLength(1);
    expect(rows[0].removals).toBe(2);
  });
});
