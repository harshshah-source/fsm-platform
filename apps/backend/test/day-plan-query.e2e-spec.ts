import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DayPlanQueryService } from '../src/scheduling/day-plan-query.service';

/**
 * Issue 11, slice 5 — the SE Day Plan read model (AC#5). getDayPlan(seId) returns the dispatched
 * plan as ordered, plant-clustered stops (stop sequence, plant name, device count per stop, the
 * stop's tickets in sort order); a fresh SE with no dispatched schedule gets the empty-state
 * ("plan being prepared"). Integration-style: builds a real dispatched plan first.
 */
const NS = Date.now();

describe('Issue 11 slice 5 — DayPlanQueryService.getDayPlan', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let dayPlan: DayPlanQueryService;

  const zoneName = 'Z-dp-' + NS;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let plantName: string;
  let se: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const NOW = new Date('2026-06-21T06:00:00Z');

  const makeTicket = async (plant: bigint, gpsAgeMin: number): Promise<string> => {
    const deviceId = String(9_700_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - gpsAgeMin * 60_000),
        plantId: plant,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId: plant,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  const makeSe = async (): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@dayplan.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    return u.userId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);
    dayPlan = new DayPlanQueryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: zoneName } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-dp-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantName = 'P-dp-' + NS;
    plantId = (await prisma.plant.create({ data: { name: plantName, zoneId } })).plantId;

    se = await makeSe();
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });

    await makeTicket(plantId, 180);
    await makeTicket(plantId, 60);

    await rec.runForZone(zoneId, { now: NOW });
    await dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW });
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

  // #147 — the read is date-filtered, so a fixture dispatched for a past day has to state its clock.
  // `NOW` is the same instant the plan was dispatched for; production passes nothing and gets today.
  it('returns the dispatched plan as ordered, plant-clustered stops with device counts', async () => {
    const view = await dayPlan.getDayPlan(se, { now: NOW });
    expect(view.dispatched).toBe(true);
    expect(view.stops).toHaveLength(1);
    const stop = view.stops[0];
    // #366 — every stop now says what kind it is; a plant stop is otherwise byte-for-byte today's.
    expect(stop.kind).toBe('PLANT');
    if (stop.kind !== 'PLANT') throw new Error('expected a plant stop');
    expect(stop.stopSequence).toBe(1);
    expect(stop.plantId).toBe(String(plantId));
    expect(stop.plantName).toBe(plantName);
    expect(stop.deviceCount).toBe(2);
    expect(stop.tickets.map((t) => t.ticketId).sort()).toEqual([...ticketIds].sort());
  });

  // #366 AC1 — a plan with nothing waiting at the warehouse must be exactly the plan it is today.
  it('carries no pickup stop when no ticket on the plan has a SHIPPED component request', async () => {
    const view = await dayPlan.getDayPlan(se, { now: NOW });
    expect(view.stops.some((s) => s.kind === 'WAREHOUSE_PICKUP')).toBe(false);
    expect(view.stops.map((s) => s.stopSequence)).toEqual([1]);
  });

  it('returns the empty-state for an SE with no dispatched schedule', async () => {
    const fresh = await makeSe();
    const view = await dayPlan.getDayPlan(fresh, { now: NOW });
    expect(view.dispatched).toBe(false);
    expect(view.stops).toEqual([]);
  });

  // #179 slice 3 — a hollow stop (every ticket removed, e.g. by a bulk unassign) must not render
  // above the SE's real remaining work. Fully self-contained fixture (own SE/plants/tickets),
  // cleaned up at the end of this test rather than via the shared afterAll.
  it('filters out a stop whose every ticket has been removed, keeping a partially-live stop', async () => {
    const hollowSe = await makeSe();
    const plantLiveId = (await prisma.plant.create({ data: { name: 'P-dp-live-' + NS, zoneId } })).plantId;
    const plantHollowId = (await prisma.plant.create({ data: { name: 'P-dp-hollow-' + NS, zoneId } })).plantId;
    await prisma.seCoverage.create({ data: { seId: hollowSe, plantId: plantLiveId, coverageType: 'MULTI_PLANT' } });
    await prisma.seCoverage.create({ data: { seId: hollowSe, plantId: plantHollowId, coverageType: 'MULTI_PLANT' } });

    const liveTicket = await makeTicket(plantLiveId, 150);
    const hollowTicket = await makeTicket(plantHollowId, 90);

    try {
      await rec.runForZone(zoneId, { now: NOW });
      await dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW });

      // Simulate a bulk unassign / override on the hollow plant's stop: stamp its ticket removed,
      // exactly as `BulkUnassignService.execute` and `OverrideService.removeTicket` do — the
      // schedule and the batch row both stay, only the ticket link is stamped.
      await prisma.batchAssignmentTicket.updateMany({
        where: { ticketId: hollowTicket },
        data: { removedAt: NOW, removedBy: hollowSe },
      });

      const view = await dayPlan.getDayPlan(hollowSe, { now: NOW });
      expect(view.dispatched).toBe(true);
      expect(view.stops).toHaveLength(1); // the hollow stop is gone, not rendered as deviceCount: 0
      const [only] = view.stops;
      if (only.kind !== 'PLANT') throw new Error('expected a plant stop');
      expect(only.plantId).toBe(String(plantLiveId));
      expect(only.tickets.map((t) => t.ticketId)).toEqual([liveTicket]);
    } finally {
      const schedules = await prisma.workSchedule.findMany({ where: { zoneId, seId: hollowSe }, select: { scheduleId: true } });
      const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } }, select: { batchId: true } });
      await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
      await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
      await prisma.workSchedule.deleteMany({ where: { zoneId, seId: hollowSe } });
      await prisma.recommendation.deleteMany({ where: { ticketId: { in: [liveTicket, hollowTicket] } } });
      await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: [liveTicket, hollowTicket] } } });
      await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: [liveTicket, hollowTicket] } } });
      await prisma.ticket.deleteMany({ where: { ticketId: { in: [liveTicket, hollowTicket] } } });
      await prisma.seCoverage.deleteMany({ where: { plantId: { in: [plantLiveId, plantHollowId] } } });
      await prisma.plant.deleteMany({ where: { plantId: { in: [plantLiveId, plantHollowId] } } });
    }
  });

  /**
   * #366 — the Zone Warehouse pickup stop.
   *
   * One fixture, four assertions, because they are one fact: an engineer whose part is waiting at the
   * zone warehouse gets **one** stop 0 naming the parts, and everything else about the plan is
   * unchanged. The three requests are deliberately in three different states — two SHIPPED on two
   * different tickets (so "one visit, however many parts" is actually exercised) and one already
   * RECEIVED (the part is in the van; there is nothing to collect and it must not appear).
   */
  it('puts exactly one pickup stop, first, naming every SHIPPED-not-RECEIVED part on the plan', async () => {
    const pickupSe = await makeSe();
    const plantOneId = (await prisma.plant.create({ data: { name: 'P-dp-pick-a-' + NS, zoneId } })).plantId;
    const plantTwoId = (await prisma.plant.create({ data: { name: 'P-dp-pick-b-' + NS, zoneId } })).plantId;
    await prisma.seCoverage.create({ data: { seId: pickupSe, plantId: plantOneId, coverageType: 'MULTI_PLANT' } });
    await prisma.seCoverage.create({ data: { seId: pickupSe, plantId: plantTwoId, coverageType: 'MULTI_PLANT' } });

    const modem = await prisma.componentMaster.create({ data: { name: 'Modem board ' + NS } });
    const antenna = await prisma.componentMaster.create({ data: { name: 'Antenna assembly ' + NS } });
    const componentIds = [modem.componentId, antenna.componentId];

    const shippedTicket = await makeTicket(plantOneId, 150);
    const secondShippedTicket = await makeTicket(plantOneId, 140);
    const receivedTicket = await makeTicket(plantTwoId, 90);
    const planTickets = [shippedTicket, secondShippedTicket, receivedTicket];
    const requestIds: string[] = [];
    const submissionIds: string[] = [];

    /** A component request on a ticket of this plan, in the state the assertion is about. */
    const request = async (ticketId: string, componentId: bigint, status: 'SHIPPED' | 'RECEIVED') => {
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId }, select: { failureCycleId: true } });
      const submission = await prisma.troubleshootingSubmission.create({
        data: {
          ticketId,
          failureCycleId: ticket.failureCycleId!,
          submissionType: 'TROUBLESHOOTING_FORM',
          clientSubmissionId: randomUUID(),
          seId: pickupSe,
          presenceSource: 'NONE',
          componentUnavailable: true,
          componentUnavailableItem: componentId,
          rootCauseCategory: 'GPS_ANTENNA_ISSUE',
          submittedAt: NOW,
        },
      });
      submissionIds.push(submission.submissionId);
      const req = await prisma.componentRequest.create({
        data: {
          ticketId,
          failureCycleId: ticket.failureCycleId!,
          submissionId: submission.submissionId,
          seId: pickupSe,
          componentId,
          status,
          shippedAt: NOW,
          receivedAt: status === 'RECEIVED' ? NOW : null,
          trackingRef: 'TRK-' + submission.submissionId.slice(0, 8),
          deliveryDestination: 'PLANT_WAREHOUSE',
        },
      });
      requestIds.push(req.requestId);
      return req.requestId;
    };

    try {
      await rec.runForZone(zoneId, { now: NOW });
      await dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW });

      const modemRequest = await request(shippedTicket, modem.componentId, 'SHIPPED');
      const antennaRequest = await request(secondShippedTicket, antenna.componentId, 'SHIPPED');
      await request(receivedTicket, modem.componentId, 'RECEIVED');

      const view = await dayPlan.getDayPlan(pickupSe, { now: NOW });

      // Exactly one pickup, and it is first: the engineer cannot do stop 1 without the part.
      expect(view.stops.filter((s) => s.kind === 'WAREHOUSE_PICKUP')).toHaveLength(1);
      const pickup = view.stops[0];
      if (pickup.kind !== 'WAREHOUSE_PICKUP') throw new Error('expected the pickup stop first');
      expect(pickup.stopSequence).toBe(0);
      expect(pickup.warehouseName).toContain(zoneName);

      // Both waiting parts named; the RECEIVED one is already in the van and is not listed.
      expect([...pickup.parts].map((p) => p.requestId).sort()).toEqual([modemRequest, antennaRequest].sort());
      expect([...pickup.parts].map((p) => p.componentName).sort()).toEqual(
        [modem.name, antenna.name].sort(),
      );
      expect(pickup.parts.every((p) => p.trackingRef !== null)).toBe(true);

      // Plant stop numbering is untouched — the pickup sits *before* stop 1, it does not renumber.
      const plantStops = view.stops.filter((s) => s.kind === 'PLANT');
      expect(plantStops.map((s) => s.stopSequence)).toEqual([1, 2]);
    } finally {
      await prisma.componentRequest.deleteMany({ where: { requestId: { in: requestIds } } });
      await prisma.troubleshootingSubmission.deleteMany({ where: { submissionId: { in: submissionIds } } });
      await prisma.componentMaster.deleteMany({ where: { componentId: { in: componentIds } } });
      const schedules = await prisma.workSchedule.findMany({ where: { zoneId, seId: pickupSe }, select: { scheduleId: true } });
      const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } }, select: { batchId: true } });
      await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
      await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
      await prisma.workSchedule.deleteMany({ where: { zoneId, seId: pickupSe } });
      await prisma.recommendation.deleteMany({ where: { ticketId: { in: planTickets } } });
      await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: planTickets } } });
      await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: planTickets } } });
      await prisma.ticket.deleteMany({ where: { ticketId: { in: planTickets } } });
      await prisma.seCoverage.deleteMany({ where: { plantId: { in: [plantOneId, plantTwoId] } } });
      await prisma.plant.deleteMany({ where: { plantId: { in: [plantOneId, plantTwoId] } } });
    }
  });
});
