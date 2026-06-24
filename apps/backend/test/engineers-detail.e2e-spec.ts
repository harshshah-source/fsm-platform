import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { EngineersQueryService } from '../src/engineers/engineers-query.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';

/**
 * Issue 25 slice 6 (AC#2) — the SE detail panel (`GET /api/engineers/:seId`): current Day Plan status,
 * per-component Van Stock, the Common-Kit chip, and the SE's availability windows. Zone-scoped — a ZM
 * requesting an out-of-zone SE gets nothing (→ 404 at the HTTP layer).
 */
const NS = Date.now();
const NOW = new Date('2026-06-25T12:00:00Z');

describe('Issue 25 slice 6 — SE detail', () => {
  let prisma: PrismaService;
  let svc: EngineersQueryService;
  let availability: SeAvailabilityService;

  let zoneA: bigint;
  let zoneB: bigint;
  let se: string;
  let componentId: bigint;
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new EngineersQueryService(prisma);
    availability = new SeAvailabilityService(prisma);

    zoneA = (await prisma.zone.create({ data: { name: 'Z-edA-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z-edB-' + NS } })).zoneId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'Detail SE ' + NS, role: 'SERVICE_ENGINEER', phone: 'ed-' + tag, email: `${tag}-${NS}@ed.test`, zoneId: zoneA },
    });
    se = u.userId;
    userIds.push(se);
    await prisma.engineerMaster.create({
      data: { engineerId: se, coverageType: 'MULTI_PLANT', zoneId: zoneA, dailyCapacity: 8, lastActivityAt: NOW },
    });

    componentId = (await prisma.componentMaster.create({ data: { name: 'Antenna-ed-' + NS } })).componentId;
    await prisma.seVanStock.create({ data: { seId: se, componentId, qty: 3 } });

    await availability.setAvailability(
      { seId: se, status: 'ON_LEAVE', windowStart: new Date('2026-06-25T00:00:00Z'), windowEnd: new Date('2026-06-26T00:00:00Z'), reason: 'leave' },
      { userId: se, role: 'SERVICE_ENGINEER', zoneId: Number(zoneA) },
    );
  });

  afterAll(async () => {
    await prisma.seVanStock.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.seAvailability.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.componentMaster.deleteMany({ where: { componentId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  it('returns the SE detail with Day Plan status, Van Stock, kit chip, and availability rows', async () => {
    const detail = await svc.getDetail(se, { role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, NOW);
    expect(detail).not.toBeNull();
    expect(detail!.name).toContain('Detail SE');
    expect(detail!.coverageType).toBe('MULTI_PLANT');
    expect(detail!.availabilityStatus).toBe('ON_LEAVE');
    expect(detail!.dayPlan.status).toBeNull(); // no active schedule
    expect(detail!.dayPlan.ticketCount).toBe(0);
    expect(detail!.vanStock).toEqual([{ componentId: String(componentId), name: expect.stringContaining('Antenna-ed'), qty: 3 }]);
    expect(typeof detail!.kit.complete).toBe('boolean');
    expect(Array.isArray(detail!.kit.missing)).toBe(true);
    expect(detail!.availabilityRows.length).toBeGreaterThanOrEqual(1);
    expect(detail!.availabilityRows[0].status).toBe('ON_LEAVE');
  });

  it('a ZM from another zone cannot see the SE (null → 404)', async () => {
    const detail = await svc.getDetail(se, { role: 'ZONAL_MANAGER', zoneId: Number(zoneB) }, NOW);
    expect(detail).toBeNull();
  });

  it('returns null for an unknown SE', async () => {
    const detail = await svc.getDetail(randomUUID(), { role: 'OPERATIONS_HEAD', zoneId: null }, NOW);
    expect(detail).toBeNull();
  });
});
