import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';
import { IntradayInsertionService } from '../src/intraday/intraday-insertion.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * #283 slice 2 — every writer stamps who, why and through which door.
 *
 * The load-bearing case is the pair this file opens with: a system CRITICAL insert and a ZM's
 * one-click assign of the *same* ticket used to produce byte-identical rows — same
 * `status: 'AUTO_ASSIGNED'`, same null `run_id`, same `CRITICAL_ASSIGN` audit action — so the only
 * discriminator was `audit_logs.actor_id = 'SYSTEM'`, one join away and easy to get wrong. #282 R2
 * makes that distinction the foundation of the whole provenance grammar, so it has to be readable
 * from the assignment row itself.
 *
 * The second defect pinned here is subtler: the system path reached `ensureSchedule`, which wrote
 * `source: 'ZM_MANUAL'` unconditionally — labelling a schedule the *engine* created as a manager's
 * manual plan.
 */
const NS = Date.now();
const BASE = new Date('2026-06-28T06:00:00Z');

describe('#283 slice 2 — add-provenance is stamped by every writer', () => {
  let prisma: PrismaService;
  let intraday: IntradayInsertionService;
  let override: OverrideService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let otherPlantId: bigint;
  let zmUserId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const makeSe = async (opts: { coverage?: 'DEDICATED' | 'MULTI_PLANT' | null } = {}): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@p283.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    });
    const coverage = opts.coverage === undefined ? 'DEDICATED' : opts.coverage;
    if (coverage) await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: coverage } });
    return u.userId;
  };

  const makeCriticalTicket = async (): Promise<string> => {
    const deviceId = String(11_930_000_000 + ((NS + deviceIds.length) % 100_000) + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(BASE.getTime() - 30 * 60 * 60_000),
        plantId,
        companyId,
        computedAt: BASE,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: BASE } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: BASE,
      },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  const liveRow = (ticketId: string) =>
    prisma.batchAssignmentTicket.findFirstOrThrow({
      where: { ticketId, removedAt: null },
      include: { batch: { include: { schedule: true } } },
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());
    intraday = new IntradayInsertionService(
      prisma,
      new CandidateSelectionService(prisma),
      override,
      new NotificationService(prisma),
      new SeAvailabilityService(prisma),
      new AuditService(prisma),
    );

    const zm = await prisma.user.create({
      data: { name: 'ZM ' + NS, role: 'ZONAL_MANAGER', phone: 'zm283-' + NS, email: `zm-${NS}@p283.test` },
    });
    zmUserId = zm.userId;
    userIds.push(zm.userId);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-283-' + NS, zonalManagerUserId: zm.userId } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-283-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-283-' + NS, zoneId } })).plantId;
    otherPlantId = (await prisma.plant.create({ data: { name: 'P2-283-' + NS, zoneId } })).plantId;
  });

  afterEach(async () => {
    await prisma.intradayInsertion.deleteMany({ where: { zoneId } });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.notification.deleteMany({ where: { recipientUserId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...ticketIds] } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId: { in: [plantId, otherPlantId] } } });
    await prisma.engineerMaster.deleteMany({ where: { zoneId } });
    ticketIds.length = 0;
    deviceIds.length = 0;
  });

  afterAll(async () => {
    await prisma.plant.deleteMany({ where: { zoneId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.onModuleDestroy();
  });

  it('AC5 — a system CRITICAL insert is stamped SYSTEM_CRITICAL on a SYSTEM_GENERATED schedule', async () => {
    await makeSe();
    const ticketId = await makeCriticalTicket();

    const outcome = await intraday.assignCriticalForZone(zoneId, BASE);
    expect(outcome.assigned).toBe(1);

    const row = await liveRow(ticketId);
    expect(row.addSource).toBe('SYSTEM_CRITICAL');
    // Nobody *added* it — the engine placed it. Same posture as `removed_by` being NULL on the
    // terminal-closure path: the actor column answers "which person did this", and here none did.
    expect(row.addedBy).toBeNull();
    // The engine already knows the tier it chose within (`chosen.coverageType`); it used to throw it away.
    expect(row.coverageTypeAtAssign).toBe('DEDICATED');
    // The defect this inverts: a schedule the SYSTEM created was labelled as a manager's manual plan.
    expect(row.batch.schedule.source).toBe('SYSTEM_GENERATED');
  });

  it('AC6 — a ZM assigning the same ticket is distinguishable from the row alone', async () => {
    const seId = await makeSe();
    const ticketId = await makeCriticalTicket();

    const res = await override.assignTicket(
      ticketId,
      seId,
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      { userId: zmUserId, role: 'ZONAL_MANAGER', actedAsRole: null },
      BASE,
    );
    expect(res.result).toBe('OK');

    const row = await liveRow(ticketId);
    expect(row.addSource).toBe('MANUAL_ASSIGN');
    expect(row.addedBy).toBe(zmUserId);
    // A human created this schedule, so ZM_MANUAL is correct here — the label is not wrong in
    // general, it was wrong only when the SYSTEM reached it.
    expect(row.batch.schedule.source).toBe('ZM_MANUAL');
  });

  it('AC8 — a manual assign to an engineer who covers nothing at that plant records NONE, not a tier', async () => {
    // #258 Q1 orders the ENGINE's candidates; it does not gate a manager, and #272 R6 makes tier
    // crossing explicitly permitted and marked. Recording this as FLOATING would be a fabrication.
    const seId = await makeSe({ coverage: null });
    const ticketId = await makeCriticalTicket();

    const res = await override.assignTicket(
      ticketId,
      seId,
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      { userId: zmUserId, role: 'ZONAL_MANAGER', actedAsRole: null },
      BASE,
    );
    expect(res.result).toBe('OK');

    const row = await liveRow(ticketId);
    expect(row.coverageTypeAtAssign).toBe('NONE');
    expect(row.addSource).toBe('MANUAL_ASSIGN');
  });

  it('AC3 — no production writer in this suite leaves a row without a source', async () => {
    // The sweep #241's own vocabulary file claims to have and does not: a writer added later that
    // forgets to stamp is invisible to every other test here, because each of those asserts about the
    // one path it drives. This one asserts about the whole zone, so a new door has to opt in.
    const seId = await makeSe();
    const viaSystem = await makeCriticalTicket();
    const viaHuman = await makeCriticalTicket();

    await intraday.assignCriticalForZone(zoneId, BASE);
    await override.assignTicket(
      viaHuman,
      seId,
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      { userId: zmUserId, role: 'ZONAL_MANAGER', actedAsRole: null },
      BASE,
    );

    const rows = await prisma.batchAssignmentTicket.findMany({
      where: { ticketId: { in: [viaSystem, viaHuman] } },
    });
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => r.addSource === null)).toEqual([]);
  });

  it('AC7 — assign-batch carries its mandatory reason onto every ticket in the lane', async () => {
    const seId = await makeSe({ coverage: 'MULTI_PLANT' });
    const a = await makeCriticalTicket();
    const b = await makeCriticalTicket();

    const res = await override.assignBatch(
      [{ seId, ticketIds: [a, b] }],
      'Monsoon backlog — cleared ahead of the shutdown',
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      { userId: zmUserId, role: 'ZONAL_MANAGER', actedAsRole: null },
      BASE,
    );
    expect(res.lanes[0].assigned).toBe(2);

    for (const ticketId of [a, b]) {
      const row = await liveRow(ticketId);
      expect(row.addSource).toBe('MANUAL_BATCH_ASSIGN');
      expect(row.addedBy).toBe(zmUserId);
      expect(row.addReason).toBe('Monsoon backlog — cleared ahead of the shutdown');
      expect(row.coverageTypeAtAssign).toBe('MULTI_PLANT');
    }
  });
});
