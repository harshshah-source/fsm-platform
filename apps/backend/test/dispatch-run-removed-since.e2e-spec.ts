import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { DispatchTransparencyQueryService } from '../src/scheduling/dispatch-transparency-query.service';

/**
 * #179 follow-up — the dispatch-run ledger is immutable history ("run N dispatched X at HH:MM"),
 * and must stay that way. But read on its own it implies that work is still on engineers' plans,
 * which is false once a bulk unassign (or a ZM override) pulled it back. The run-detail zone card
 * therefore carries two LIVE-derived counters alongside the historical `ticketsDispatched`:
 * `ticketsStillAssigned` and `ticketsRemovedSince`. Derived from the run's own batch rows
 * (`plant_batch_assignments.run_id`), so nothing in the ledger is rewritten.
 */
const NS = Date.now();
const NOW = new Date('2026-07-29T09:00:00Z');
const DAY = new Date(Date.UTC(2026, 6, 29));
const OH_SCOPE = { role: 'OPERATIONS_HEAD', zoneId: null };

describe('dispatch run detail — ticketsRemovedSince (#179 follow-up)', () => {
  let prisma: PrismaService;
  let svc: DispatchTransparencyQueryService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new DispatchTransparencyQueryService(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('reports how many of a run dispatched tickets are still assigned vs removed since', async () => {
    const zoneId = (await prisma.zone.create({ data: { name: 'Z-removed-' + NS } })).zoneId;
    const companyId = (await prisma.company.create({ data: { name: 'Co-removed-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    const plantId = (await prisma.plant.create({ data: { name: 'P-removed-' + NS, zoneId } })).plantId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@removed.test`, zoneId } });
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });

    const run = await prisma.dispatchRun.create({
      data: { trigger: 'CRON', startedAt: NOW, finishedAt: NOW, status: 'SUCCESS', configSnapshot: {}, ticketsDispatched: 3, schedules: 1, batches: 1, zones: 1 },
    });
    await prisma.dispatchRunZone.create({
      data: { runId: run.runId, zoneId, status: 'DONE', ticketsConsidered: 3, recommended: 3, unassignable: 0, schedules: 1, batches: 1, ticketsDispatched: 3, startedAt: NOW, finishedAt: NOW },
    });

    const schedule = await prisma.workSchedule.create({
      data: { seId: u.userId, zoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', source: 'SYSTEM_GENERATED', dispatchedAt: NOW, runId: run.runId },
    });
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId: u.userId, status: 'AUTO_ASSIGNED', stopSequence: 1, runId: run.runId },
    });

    const ticketIds: string[] = [];
    const deviceIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const deviceId = String(9_833_000_000 + (NS % 100_000) * 10 + i);
      deviceIds.push(deviceId);
      await prisma.device.create({ data: { deviceId } });
      const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
      const t = await prisma.ticket.create({
        data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', assignmentState: 'FORMALLY_ASSIGNED', lastStateChangedAt: NOW },
      });
      ticketIds.push(t.ticketId);
      await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId: t.ticketId, sortOrder: i + 1 } });
    }

    try {
      // Before any removal: all 3 dispatched are still assigned.
      const before = await svc.getRunDetail(run.runId, OH_SCOPE);
      const zoneBefore = before!.zones.find((z) => z.zoneId === zoneId.toString());
      expect(zoneBefore!.ticketsDispatched).toBe(3);
      expect(zoneBefore!.ticketsStillAssigned).toBe(3);
      expect(zoneBefore!.ticketsRemovedSince).toBe(0);

      // Two are pulled back (a bulk unassign / ZM override stamps removed_at the same way).
      await prisma.batchAssignmentTicket.updateMany({
        where: { ticketId: { in: [ticketIds[0], ticketIds[1]] } },
        data: { removedAt: new Date('2026-07-29T16:22:00Z'), removedBy: u.userId },
      });

      const after = await svc.getRunDetail(run.runId, OH_SCOPE);
      const zoneAfter = after!.zones.find((z) => z.zoneId === zoneId.toString());
      // The LEDGER is untouched — still records what the run dispatched.
      expect(zoneAfter!.ticketsDispatched).toBe(3);
      // The live counters tell the truth about now.
      expect(zoneAfter!.ticketsStillAssigned).toBe(1);
      expect(zoneAfter!.ticketsRemovedSince).toBe(2);
    } finally {
      await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: batch.batchId } });
      await prisma.plantBatchAssignment.deleteMany({ where: { batchId: batch.batchId } });
      await prisma.workSchedule.deleteMany({ where: { scheduleId: schedule.scheduleId } });
      await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
      await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
      await prisma.dispatchRunZone.deleteMany({ where: { runId: run.runId } });
      await prisma.dispatchRun.deleteMany({ where: { runId: run.runId } });
      await prisma.engineerMaster.deleteMany({ where: { engineerId: u.userId } });
      await prisma.user.deleteMany({ where: { userId: u.userId } });
      await prisma.plant.deleteMany({ where: { plantId } });
      await prisma.company.deleteMany({ where: { companyId } });
      await prisma.zone.deleteMany({ where: { zoneId } });
    }
  });
});
