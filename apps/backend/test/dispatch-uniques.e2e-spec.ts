import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 100 AC#3 — the DB backstops. Two partial-unique indexes make double-dispatch impossible even
 * if the transaction + advisory lock are somehow bypassed (a second process, a bug):
 *   - `recommendations(ticket_id) WHERE status='SUGGESTED'` — at most one live suggestion per ticket.
 *   - `work_schedules(se_id, zone_id, date_from) WHERE status='ACTIVE'` — one active day-plan per SE
 *     per zone per day. `zone_id` is in the key deliberately: a floating SE legitimately holds a plan
 *     in more than one zone the same day (per-zone dispatch, cross-zone approve), so the constraint is
 *     per-(SE, zone, day), not per-(SE, day).
 * Tested at the schema seam: the constraint itself is the unit under test.
 */
const NS = Date.now();
const P2002 = (e: unknown) => (e as { code?: string }).code === 'P2002';
const DAY = new Date('2026-06-21T00:00:00Z');

describe('Issue 100 — dispatch uniqueness backstops', () => {
  let prisma: PrismaService;
  let zoneA: bigint;
  let zoneB: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const scheduleIds: bigint[] = [];

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(9_490_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: DAY } });
    const t = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: DAY },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  const activeSchedule = (zoneId: bigint) =>
    prisma.workSchedule.create({ data: { seId, zoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', source: 'SYSTEM_GENERATED' } })
      .then((s) => { scheduleIds.push(s.scheduleId); return s; });

  const suggested = (ticketId: string) =>
    prisma.recommendation.create({ data: { ticketId, seId, companyTier: 'GOLD', deviceBucket: 'CRITICAL', scoreBreakdown: {}, processingRank: 1, status: 'SUGGESTED', path: 'MORNING_BATCH' } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    companyId = (await prisma.company.create({ data: { name: 'Co-uq-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    zoneA = (await prisma.zone.create({ data: { name: 'ZA-uq-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'ZB-uq-' + NS } })).zoneId;
    plantId = (await prisma.plant.create({ data: { name: 'P-uq-' + NS, zoneId: zoneA } })).plantId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@uq.test`, zoneId: zoneA } });
    userIds.push(u.userId);
    seId = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: seId, coverageType: 'FLOATING', zoneId: zoneA, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.workSchedule.deleteMany({ where: { scheduleId: { in: scheduleIds } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.onModuleDestroy();
  });

  it('rejects a second ACTIVE work_schedule for the same (se, zone, day)', async () => {
    await activeSchedule(zoneA);
    await expect(activeSchedule(zoneA)).rejects.toSatisfy(P2002);
  });

  it('allows the same SE an ACTIVE schedule in a DIFFERENT zone on the same day (floating/cross-zone)', async () => {
    await expect(activeSchedule(zoneB)).resolves.toBeDefined();
  });

  it('rejects a second SUGGESTED recommendation for the same ticket', async () => {
    const ticketId = await makeTicket();
    await suggested(ticketId);
    await expect(suggested(ticketId)).rejects.toSatisfy(P2002);
  });

  it('allows a fresh SUGGESTED once the prior one is consumed (DISPATCHED)', async () => {
    const ticketId = await makeTicket();
    const first = await suggested(ticketId);
    await prisma.recommendation.update({ where: { recommendationId: first.recommendationId }, data: { status: 'DISPATCHED' } });
    await expect(suggested(ticketId)).resolves.toBeDefined();
  });
});
