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
 * #277 (part 2) — `GET /intraday-insertions/:id/available-ses` returns #274's candidate row instead of
 * a bare `string[]`. Exercised at the {@link IntradayInsertionService} seam directly, matching
 * `intraday-critical-insertion.e2e-spec.ts` (the controller is a thin scope-forwarding wrapper).
 *
 * The pin that matters: the **set** of SEs offered is unchanged from before this issue — filtered on
 * live availability only, never on the richer hard-filter verdict `CandidateQueryService` also carries.
 * An over-capacity SE was always offered here (Q2 — a ZM's escalation resolution is an administrative
 * override, not a gate); the shape change must not silently narrow that set.
 */
const NS = Date.now();
const BASE = new Date('2026-06-28T06:00:00Z');

describe('#277 — available-ses candidate row shape', () => {
  let prisma: PrismaService;
  let svc: IntradayInsertionService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let zmUserId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const makeSe = async (opts: { dailyCapacity?: number; name?: string } = {}): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: opts.name ?? 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@as.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: opts.dailyCapacity ?? 10 },
    });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    return u.userId;
  };

  const makeTicketAndInsertion = async (): Promise<bigint> => {
    const deviceId = String(11_800_000_000 + ((NS + deviceIds.length) % 100_000) + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
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
    const ins = await prisma.intradayInsertion.create({
      data: {
        ticketId: t.ticketId,
        zoneId,
        insertionType: 'SYSTEM_CRITICAL',
        slaBucket: 'CRITICAL',
        offeredSeId: null,
        offeredAt: BASE,
        acceptanceDeadline: null,
        status: 'ESCALATION_REQUIRED',
      },
    });
    return ins.insertionId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new IntradayInsertionService(
      prisma,
      new CandidateSelectionService(prisma),
      new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier()),
      new NotificationService(prisma),
      new SeAvailabilityService(prisma),
      new AuditService(prisma),
    );

    const zm = await prisma.user.create({
      data: { name: 'ZM ' + NS, role: 'ZONAL_MANAGER', phone: 'zm-as-' + NS, email: `zm-as-${NS}@as.test` },
    });
    zmUserId = zm.userId;
    userIds.push(zm.userId);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-as-' + NS, zonalManagerUserId: zm.userId } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-as-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-as-' + NS, zoneId } })).plantId;
  });

  afterEach(async () => {
    await prisma.intradayInsertion.deleteMany({ where: { zoneId } });
    await prisma.auditLog.deleteMany({
      where: { entityType: { in: ['ticket', 'failure_cycles'] }, entityId: { in: [...ticketIds] } },
    });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.seAvailability.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds.filter((id) => id !== zmUserId) } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds.filter((id) => id !== zmUserId) } } });
    ticketIds.length = 0;
    deviceIds.length = 0;
    userIds.length = 1; // keep the ZM
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { userId: zmUserId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('returns candidate rows carrying name, coverage, load and capacity — never a bare id', async () => {
    const se = await makeSe({ name: 'Priya Rao' });
    const insertionId = await makeTicketAndInsertion();

    const rows = await svc.availableSesForManualAssign(insertionId, { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) }, BASE);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seId: se,
      name: 'Priya Rao',
      coverageType: 'DEDICATED',
      committed: 0,
      dailyCapacity: 10,
      availabilityStatus: 'AVAILABLE',
    });
  });

  it('set-equality pin: excludes an unavailable SE, includes an over-capacity one — same set as the old string[]', async () => {
    const unavailable = await makeSe();
    await prisma.seAvailability.create({
      data: { seId: unavailable, status: 'SOFT_UNAVAILABLE', windowStart: new Date(BASE.getTime() - 3_600_000), windowEnd: null },
    });
    const overCapacity = await makeSe({ dailyCapacity: 0 });
    const insertionId = await makeTicketAndInsertion();

    const rows = await svc.availableSesForManualAssign(insertionId, { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) }, BASE);

    const seIds = rows.map((r) => r.seId).sort();
    expect(seIds).toEqual([overCapacity].sort());
    // Offered despite being over capacity — Q2's administrative override, not a hard-filter gate.
    expect(rows.find((r) => r.seId === overCapacity)?.dailyCapacity).toBe(0);
  });

  it('an insertion with no plant candidates returns an empty list, not an error', async () => {
    const insertionId = await makeTicketAndInsertion();
    const rows = await svc.availableSesForManualAssign(insertionId, { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) }, BASE);
    expect(rows).toEqual([]);
  });
});
