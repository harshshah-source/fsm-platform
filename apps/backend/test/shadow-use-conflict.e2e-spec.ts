import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { TroubleshootSubmissionService } from '../src/ticketing/troubleshoot-submission.service';

/**
 * Issue 24, slice 2 — the dual-SE conflict (CONTEXT §Business 409 Conflict / §Shadow Use). A normal
 * submit records consumed components as PRE_VERIFICATION inventory and decrements the SE's van stock.
 * A second SE submitting on the now-closed Ticket gets a business CONFLICT (distinct from an
 * idempotency duplicate); the components they physically consumed are decremented from THEIR van stock
 * and logged as SHADOW_USE for warehouse reconciliation. Both engineers' van stock stays accurate (AC#6).
 */
const NS = Date.now();
const NOW = new Date('2026-06-24T09:00:00Z');

describe('Issue 24 slice 2 — 409 conflict + shadow use + consumption', () => {
  let prisma: PrismaService;
  let svc: TroubleshootSubmissionService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let cable: bigint;
  let winner: string;
  let loser: string;
  const engineers: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const seedSe = async (qty: number): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'se-' + tag, email: `se-${tag}@su.test`, zoneId } });
    engineers.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seVanStock.create({ data: { seId: u.userId, componentId: cable, qty } });
    return u.userId;
  };
  const makeTicket = async (): Promise<{ ticketId: string }> => {
    const deviceId = BigInt(12_600_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({ data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW } });
    ticketIds.push(ticket.ticketId);
    return { ticketId: ticket.ticketId };
  };
  const stockOf = async (se: string) => (await prisma.seVanStock.findFirstOrThrow({ where: { seId: se, componentId: cable } })).qty;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new TroubleshootSubmissionService(prisma);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-su-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-su-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-su-' + NS, zoneId } })).plantId;
    cable = (await prisma.componentMaster.create({ data: { name: 'cable-su-' + NS } })).componentId;
    winner = await seedSe(5);
    loser = await seedSe(5);
  });

  afterAll(async () => {
    await prisma.inventoryTransaction.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seVanStock.deleteMany({ where: { seId: { in: engineers } } });
    await prisma.componentMaster.deleteMany({ where: { componentId: cable } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: engineers } } });
    await prisma.user.deleteMany({ where: { userId: { in: engineers } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('records normal consumption as PRE_VERIFICATION and decrements the winner van stock', async () => {
    const { ticketId } = await makeTicket();
    const out = await svc.submit({
      ticketId, seId: winner, clientSubmissionId: randomUUID(), rootCauseCategory: 'WIRING_ISSUE',
      consumedComponents: [{ componentId: cable, qty: 2 }], actor: { userId: winner, role: 'SERVICE_ENGINEER' }, now: NOW,
    });
    expect(out.result).toBe('OK');
    const txns = await prisma.inventoryTransaction.findMany({ where: { ticketId, seId: winner } });
    expect(txns.length).toBe(1);
    expect(txns[0].status).toBe('PRE_VERIFICATION');
    expect(txns[0].qty).toBe(2);
    expect(await stockOf(winner)).toBe(3); // 5 - 2
  });

  it('returns a business CONFLICT for a second SE and logs SHADOW_USE, decrementing their stock', async () => {
    const { ticketId } = await makeTicket();
    // Winner submits and the ticket leaves OPEN.
    await svc.submit({ ticketId, seId: winner, clientSubmissionId: randomUUID(), rootCauseCategory: 'WIRING_ISSUE', actor: { userId: winner, role: 'SERVICE_ENGINEER' }, now: NOW });
    // Loser submits late, having consumed a cable in the field.
    const out = await svc.submit({
      ticketId, seId: loser, clientSubmissionId: randomUUID(), rootCauseCategory: 'WIRING_ISSUE',
      consumedComponents: [{ componentId: cable, qty: 1 }], actor: { userId: loser, role: 'SERVICE_ENGINEER' }, now: NOW,
    });
    expect(out.result).toBe('CONFLICT');
    expect(out.result === 'CONFLICT' && out.shadowUseRecorded).toBe(true);
    expect(out.result === 'CONFLICT' && out.conflict.winnerSeId).toBe(winner);

    const shadow = await prisma.inventoryTransaction.findMany({ where: { ticketId, seId: loser, status: 'SHADOW_USE' } });
    expect(shadow.length).toBe(1);
    expect(shadow[0].qty).toBe(1);
    expect(await stockOf(loser)).toBe(4); // 5 - 1, accurate despite the conflict (AC#6)
  });

  it('keeps an idempotency duplicate distinct from a conflict (no inventory movement)', async () => {
    const { ticketId } = await makeTicket();
    const clientSubmissionId = randomUUID();
    await svc.submit({ ticketId, seId: winner, clientSubmissionId, rootCauseCategory: 'WIRING_ISSUE', consumedComponents: [{ componentId: cable, qty: 1 }], actor: { userId: winner, role: 'SERVICE_ENGINEER' }, now: NOW });
    const before = await prisma.inventoryTransaction.count({ where: { ticketId } });
    const dup = await svc.submit({ ticketId, seId: winner, clientSubmissionId, rootCauseCategory: 'WIRING_ISSUE', consumedComponents: [{ componentId: cable, qty: 1 }], actor: { userId: winner, role: 'SERVICE_ENGINEER' }, now: NOW });
    expect(dup.result).toBe('DUPLICATE');
    expect(await prisma.inventoryTransaction.count({ where: { ticketId } })).toBe(before);
  });
});
