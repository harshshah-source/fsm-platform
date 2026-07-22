import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';

/**
 * Issue 100 AC#1 + idempotency — a dispatch write leaves NO partial or DUPLICATED state. We pre-occupy
 * one of the SE's tickets in another SE's active batch (the state
 * `batch_assignment_tickets_one_active_per_ticket` forbids). The idempotency guard now DETECTS that the
 * ticket is already live and skips it — so the SE's remaining (non-conflicting) work still dispatches
 * cleanly, the already-assigned ticket is never assigned twice, and no P2002 rollback is needed. The
 * partial-unique index remains the final backstop behind the guard.
 */
const NS = Date.now();

describe('Issue 100 — dispatchForZone is transactional (rolls back a partial SE plan)', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  let strayerId: string;
  let strayScheduleId: bigint;
  let strayBatchId: bigint;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const NOW = new Date('2026-06-21T06:00:00Z');

  const makeTicket = async (gpsAgeMin: number): Promise<string> => {
    const deviceId = String(9_480_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId, isInactive: true, slaBucket: 'CRITICAL', eligibleForUptime: true, hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - gpsAgeMin * 60_000), plantId, companyId, computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-tx-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-tx-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-tx-' + NS, zoneId } })).plantId;

    const mkSe = async (): Promise<string> => {
      const tag = randomUUID().slice(0, 8);
      const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@tx.test`, zoneId } });
      userIds.push(u.userId);
      await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
      return u.userId;
    };
    seId = await mkSe();
    strayerId = await mkSe();
    await prisma.seCoverage.create({ data: { seId, plantId, coverageType: 'DEDICATED' } });

    const t1 = await makeTicket(120);
    await makeTicket(60);
    await rec.runForZone(zoneId, { now: NOW });

    // Pre-occupy t1 in an ACTIVE batch under another SE, so dispatch's insert of t1 will P2002.
    const s = await prisma.workSchedule.create({ data: { seId: strayerId, zoneId, dateFrom: NOW, dateTo: NOW, status: 'ACTIVE', source: 'ZM_MANUAL' } });
    strayScheduleId = s.scheduleId;
    const b = await prisma.plantBatchAssignment.create({ data: { scheduleId: s.scheduleId, plantId, seId: strayerId, status: 'AUTO_ASSIGNED', stopSequence: 1 } });
    strayBatchId = b.batchId;
    await prisma.batchAssignmentTicket.create({ data: { batchId: b.batchId, ticketId: t1, sortOrder: 1 } });
  });

  afterAll(async () => {
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: strayBatchId } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: strayBatchId } });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } }, select: { batchId: true } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('an already-assigned ticket is skipped; the rest of the SE plan dispatches with no partial/duplicate state', async () => {
    const [t1, t2] = ticketIds;

    const out = await dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW });
    expect(out.tickets).toBe(1); // only the non-conflicting ticket dispatched; t1 skipped by the guard

    // t1 (already live in the stray SE's batch) keeps exactly ONE live assignment — never duplicated.
    const t1Live = await prisma.batchAssignmentTicket.findMany({ where: { ticketId: t1, removedAt: null } });
    expect(t1Live).toHaveLength(1);
    expect(t1Live[0].batchId).toBe(strayBatchId);

    // t1 untouched by the target-SE dispatch; t2 cleanly assigned — no half-written state.
    const tickets = await prisma.ticket.findMany({ where: { ticketId: { in: ticketIds } } });
    const stateById = new Map(tickets.map((t) => [t.ticketId, t.assignmentState]));
    expect(stateById.get(t1)).toBe('UNASSIGNED');
    expect(stateById.get(t2)).toBe('FORMALLY_ASSIGNED');

    // Both recs are consumed (done with, never re-looped); exactly one target-SE schedule holding just t2.
    const recs = await prisma.recommendation.findMany({ where: { ticketId: { in: ticketIds }, seId: { not: null } } });
    expect(recs.every((r) => r.status === 'DISPATCHED')).toBe(true);
    const targetSchedules = await prisma.workSchedule.findMany({
      where: { zoneId, seId },
      include: { batches: { include: { tickets: { where: { removedAt: null } } } } },
    });
    expect(targetSchedules).toHaveLength(1);
    expect(targetSchedules[0].batches.flatMap((b) => b.tickets.map((t) => t.ticketId))).toEqual([t2]);
  });
});
