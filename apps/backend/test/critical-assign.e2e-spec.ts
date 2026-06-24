import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * Issue 13a, slice 6 — Grouped Critical Work Queue one-click assign (AC#6). assignTicket creates a
 * Formal Assignment for a critical OPEN ticket → SE: ensures the SE's schedule + plant batch, adds the
 * ticket, and flips it FORMALLY_ASSIGNED so it leaves the Shared Pool. Re-assigning an already-assigned
 * ticket conflicts.
 */
const NS = Date.now();

describe('Issue 13a slice 6 — critical-queue one-click assign', () => {
  let prisma: PrismaService;
  let override: OverrideService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let ticketId: string;
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const ZM = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };
  const NOW = new Date('2026-06-21T06:00:00Z');
  let scope: { role: string; zoneId: number };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());

    zoneId = (await prisma.zone.create({ data: { name: 'Z-ca-' + NS } })).zoneId;
    scope = { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) };
    companyId = (
      await prisma.company.create({ data: { name: 'Co-ca-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-ca-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@ca.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });

    const deviceId = BigInt(10_600_000_000 + (NS % 100_000));
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 120 * 60_000),
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    ticketId = (
      await prisma.ticket.create({
        data: {
          workType: 'TROUBLESHOOT',
          status: 'OPEN',
          failureCycleId: cycle.cycleId,
          deviceId,
          plantId,
          companyId,
          companyTier: 'GOLD',
          lastStateChangedAt: NOW,
        },
      })
    ).ticketId;
    ticketIds.push(ticketId);
  });

  afterAll(async () => {
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'ticket', entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('creates a Formal Assignment (schedule + batch + ticket) and flips the ticket FORMALLY_ASSIGNED', async () => {
    const outcome = await override.assignTicket(ticketId, se, scope, ZM, NOW);
    expect(outcome.result).toBe('OK');

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');

    const schedule = await prisma.workSchedule.findFirstOrThrow({ where: { zoneId, seId: se } });
    const batch = await prisma.plantBatchAssignment.findFirstOrThrow({ where: { scheduleId: schedule.scheduleId, plantId } });
    const bat = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { batchId: batch.batchId, ticketId } });
    expect(bat.removedAt).toBeNull();
  });

  it('conflicts when the ticket is already formally assigned', async () => {
    const outcome = await override.assignTicket(ticketId, se, scope, ZM, NOW);
    expect(outcome.result).toBe('ALREADY_ASSIGNED');
  });
});
