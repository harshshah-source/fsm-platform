import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';
import { SameDayUpdateService } from '../src/scheduling/same-day-update.service';

/**
 * Issue 31 slice 1 — the ZM manual same-day update ADD path. The ZM adds an open Ticket to an SE's
 * current Day Plan mid-shift; it applies immediately (FORMALLY_ASSIGNED — no SE Acceptance), and the
 * change is logged as a `MANUAL_ZM_UPDATE` intra-day row (AuditLog view, per the 2026-06-25 decision —
 * no new model; Issue 29 later adds CRITICAL rows to the same view). `listIntradayUpdates` is the
 * Intra-day Queue read, zone-scoped (a ZM sees only their own zone).
 */
const NS = Date.now();

describe('Issue 31 slice 1 — ZM same-day update (ADD)', () => {
  let prisma: PrismaService;
  let sameDay: SameDayUpdateService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let ticketId: string;
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const ZM = { userId: '31111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };
  const NOW = new Date('2026-06-25T06:00:00Z');
  let scope: { role: string; zoneId: number };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());
    sameDay = new SameDayUpdateService(prisma, override);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-sdu-' + NS } })).zoneId;
    scope = { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) };
    companyId = (
      await prisma.company.create({ data: { name: 'Co-sdu-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-sdu-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'sdu-' + tag, email: `${tag}-${NS}@sdu.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });

    const deviceId = BigInt(10_900_000_000 + (NS % 100_000));
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
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
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('adds an open ticket to the SE current Day Plan immediately (no acceptance gate)', async () => {
    const outcome = await sameDay.addTicket(ticketId, se, scope, ZM, NOW);
    expect(outcome.result).toBe('OK');

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');
  });

  it('logs the change as a MANUAL_ZM_UPDATE intra-day row (not CRITICAL_ASSIGN)', async () => {
    const rows = await prisma.auditLog.findMany({ where: { entityType: 'ticket', entityId: ticketId } });
    expect(rows.some((r) => r.action === 'MANUAL_ZM_UPDATE')).toBe(true);
    expect(rows.some((r) => r.action === 'CRITICAL_ASSIGN')).toBe(false);
  });

  it('surfaces the update in the zone-scoped Intra-day Queue read', async () => {
    const updates = await sameDay.listIntradayUpdates(scope);
    const row = updates.find((u) => u.ticketId === ticketId);
    expect(row).toBeDefined();
    expect(row!.updateType).toBe('ADD');
    expect(row!.seId).toBe(se);
    expect(row!.actorId).toBe(ZM.userId);
  });

  it('hides the update from a different zone (ZM zone-scoping)', async () => {
    const otherZone = await sameDay.listIntradayUpdates({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) + 999999 });
    expect(otherZone.some((u) => u.ticketId === ticketId)).toBe(false);
  });
});
