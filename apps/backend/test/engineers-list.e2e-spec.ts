import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { EngineersQueryService } from '../src/engineers/engineers-query.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';

/**
 * Issue 25 slice 5 (AC#1) — the SE Management list (`GET /api/engineers`). Per SE: name, coverage
 * type, the render-time derived Activity Status (reusing the proven `deriveActivityStatus`), the
 * stored availability status, today's day-plan ticket count, and the Common-Kit completeness chip.
 * Zone-scoped: a ZM sees only their own zone; CSM / Operations Head see all. The pure derivation is
 * unit-proven in `activity-status.spec.ts`; here we prove the list sources + zone scope + integration.
 */
const NS = Date.now();
const NOW = new Date('2026-06-25T12:00:00Z');

describe('Issue 25 slice 5 — SE Management list', () => {
  let prisma: PrismaService;
  let svc: EngineersQueryService;
  let availability: SeAvailabilityService;

  let zoneA: bigint;
  let zoneB: bigint;
  let plantA: bigint;
  let companyId: bigint;
  let seLeave: string; // zone A — ON_LEAVE window active
  let seBusy: string; // zone A — TROUBLESHOOT_STARTED soft state → BUSY
  let seB: string; // zone B
  const userIds: string[] = [];
  let deviceId: bigint;
  let ticketId: string;

  const makeSe = async (zoneId: bigint, name: string): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name, role: 'SERVICE_ENGINEER', phone: 'el-' + tag, email: `${tag}-${NS}@el.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10, lastActivityAt: NOW },
    });
    return u.userId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new EngineersQueryService(prisma);
    availability = new SeAvailabilityService(prisma);

    zoneA = (await prisma.zone.create({ data: { name: 'Z-elA-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z-elB-' + NS } })).zoneId;
    plantA = (await prisma.plant.create({ data: { name: 'P-el-' + NS, zoneId: zoneA } })).plantId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-el-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;

    seLeave = await makeSe(zoneA, 'Leave SE ' + NS);
    seBusy = await makeSe(zoneA, 'Busy SE ' + NS);
    seB = await makeSe(zoneB, 'Other Zone SE ' + NS);

    // seLeave: active ON_LEAVE window over NOW.
    await availability.setAvailability(
      { seId: seLeave, status: 'ON_LEAVE', windowStart: new Date('2026-06-25T00:00:00Z'), windowEnd: new Date('2026-06-26T00:00:00Z') },
      { userId: seLeave, role: 'SERVICE_ENGINEER', zoneId: Number(zoneA) },
    );

    // seBusy: an active TROUBLESHOOT_STARTED soft state on a ticket → derived BUSY.
    deviceId = BigInt(9_500_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId: plantA,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    ticketId = ticket.ticketId;
    await prisma.softState.create({
      data: { ticketId, seId: seBusy, type: 'TROUBLESHOOT_STARTED', setAt: NOW },
    });
  });

  afterAll(async () => {
    if (ticketId) {
      await prisma.softState.deleteMany({ where: { ticketId } });
      await prisma.ticket.deleteMany({ where: { ticketId } });
    }
    await prisma.failureCycle.deleteMany({ where: { deviceId } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.seAvailability.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: plantA } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  it('a ZM sees only own-zone SEs with name, coverage type, and Common-Kit chip', async () => {
    const rows = await svc.listForZone({ role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, NOW);
    const ids = rows.map((r) => r.seId);
    expect(ids).toContain(seLeave);
    expect(ids).toContain(seBusy);
    expect(ids).not.toContain(seB);

    const leave = rows.find((r) => r.seId === seLeave)!;
    expect(leave.name).toContain('Leave SE');
    expect(leave.coverageType).toBe('DEDICATED');
    expect(leave.kitComplete).toBe(true); // no van-stock rows ⇒ kit-complete
    expect(leave.activeTicketCount).toBe(0);
  });

  it('derives Activity Status from the active availability window (ON_LEAVE)', async () => {
    const rows = await svc.listForZone({ role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, NOW);
    const leave = rows.find((r) => r.seId === seLeave)!;
    expect(leave.availabilityStatus).toBe('ON_LEAVE');
    expect(leave.activityStatus).toBe('ON_LEAVE');
  });

  it('derives BUSY from an active TROUBLESHOOT_STARTED soft state', async () => {
    const rows = await svc.listForZone({ role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, NOW);
    const busy = rows.find((r) => r.seId === seBusy)!;
    expect(busy.availabilityStatus).toBe('AVAILABLE');
    expect(busy.activityStatus).toBe('BUSY');
  });

  it('a cross-zone role (Operations Head) sees SEs across zones', async () => {
    const rows = await svc.listForZone({ role: 'OPERATIONS_HEAD', zoneId: null }, NOW);
    const ids = rows.map((r) => r.seId);
    expect(ids).toContain(seLeave);
    expect(ids).toContain(seB);
  });
});
