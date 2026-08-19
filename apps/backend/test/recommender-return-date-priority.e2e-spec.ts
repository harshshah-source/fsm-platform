import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { type SlaBucket } from '../src/device-state/sla-bucket';

/**
 * #248 — Option C end to end: the run's `processing_rank` order really is
 * **Critical/Severe → return-date → normal backlog**, and the flag that produces it costs one query.
 *
 * `returnDueToday` is derived per run and stored nowhere (AC2). That is the load-bearing choice: a
 * stored flag would have to be written when a report is filed, rewritten when a manager moves the
 * date, and cleared when the ticket is dispatched or the report superseded — four writers for a fact
 * that is a pure function of one column and today's date, and any one of them missing leaves a ticket
 * jumping the queue forever. So the run reads it, once, for the candidates it is about to rank.
 */
const NS = Date.now();
/** 11:30 IST on 2026-06-21 — mid-morning, so "today" and "tomorrow" are unambiguous in IST. */
const NOW = new Date('2026-06-21T06:00:00Z');

describe('#248 — return-date priority through a real run', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const runIds: bigint[] = [];

  /** An OPEN, unassigned TROUBLESHOOT ticket in `bucket`, at the covered plant. */
  const makeTicket = async (bucket: SlaBucket, gpsAgeMin: number): Promise<string> => {
    const deviceId = String(9_480_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: bucket,
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - gpsAgeMin * 60_000),
        plantId,
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
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  /** A live vehicle wait on the ticket, the vehicle due back on `expectedFrom`. */
  const fileWait = (ticketId: string, seId: string, expectedFrom: Date, status: 'OPEN' | 'RESOLVED' = 'OPEN') =>
    prisma.vehicleUnavailabilityReport.create({
      data: {
        ticketId,
        seId,
        reasonCode: 'VEHICLE_ON_TRIP',
        transporterContacted: false,
        proposedFrom: expectedFrom,
        expectedFrom,
        status,
      },
    });

  /** A fresh ledger row to hang one run's recommendations off, so each case reads only its own. */
  const newRun = async (): Promise<bigint> => {
    const run = await prisma.dispatchRun.create({ data: { trigger: 'MANUAL', configSnapshot: {} } });
    runIds.push(run.runId);
    return run.runId;
  };

  const rankedOrder = async (runId: bigint): Promise<string[]> => {
    const rows = await prisma.recommendation.findMany({
      where: { runId },
      select: { ticketId: true, processingRank: true },
      orderBy: { processingRank: 'asc' },
    });
    return rows.map((r) => r.ticketId);
  };

  let se: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-rdp-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-rdp-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-rdp-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'rdp-' + tag, email: `${tag}-${NS}@rdp.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    // Ample capacity: this spec is about ORDER, so nothing must fall out for want of an engineer.
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 50 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });
  });

  afterAll(async () => {
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    if (runIds.length) await prisma.dispatchRun.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.vehicleUnavailabilityReport.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('AC1/AC2 — the produced processing order is Critical+ → return-due → normal backlog', async () => {
    // Ages are chosen so that WITHOUT the new key the order would be strictly oldest-first within the
    // RISK bucket — i.e. `normalOld` ahead of `due`. The flag has to be what moves it.
    const critical = await makeTicket('CRITICAL', 400);
    const due = await makeTicket('RISK', 100);
    const normalOld = await makeTicket('RISK', 300);
    const normalNew = await makeTicket('RISK', 50);
    // Due back at 09:00 IST today: the wait is over, the ticket is selectable again.
    await fileWait(due, se, new Date('2026-06-21T03:30:00Z'));
    // A control: an OPEN wait whose date is still two days out must NOT read as return-due. (It is
    // also excluded from selection by its deferral, which is asserted separately below.)
    const stillWaiting = await makeTicket('RISK', 350);
    await fileWait(stillWaiting, se, new Date('2026-06-23T03:30:00Z'));
    await prisma.ticket.update({
      where: { ticketId: stillWaiting },
      data: { deferredUntil: new Date('2026-06-23T00:00:00.000Z') },
    });
    // A second control: a RESOLVED report is not a live wait, whatever its date says.
    const resolvedWait = await makeTicket('RISK', 320);
    await fileWait(resolvedWait, se, new Date('2026-06-21T03:30:00Z'), 'RESOLVED');

    const runId = await newRun();
    await rec.runForZone(zoneId, { now: NOW, runId });

    const order = await rankedOrder(runId);
    // `resolvedWait` is the OLDEST RISK ticket (320 min) and still sorts behind `due` (100 min) —
    // which is the whole proof that a RESOLVED report did not earn the flag. Had it, age would have
    // put it ahead of `due` inside the return-due group.
    expect(order).toEqual([critical, due, resolvedWait, normalOld, normalNew]);
    // The still-deferred ticket was never a candidate at all — #146's predicate, unchanged by #248.
    expect(order).not.toContain(stillWaiting);
  });

  it('AC2 — the flag costs one query for the whole run, not one per candidate', async () => {
    for (let i = 0; i < 6; i += 1) {
      const id = await makeTicket('RISK', 100 + i);
      if (i % 2 === 0) await fileWait(id, se, new Date('2026-06-21T03:30:00Z'));
    }
    // Explicit passthrough: a bare spy would stub the delegate and the run would read nothing.
    const passthrough = prisma.vehicleUnavailabilityReport.findMany.bind(prisma.vehicleUnavailabilityReport);
    const spy = vi.spyOn(prisma.vehicleUnavailabilityReport, 'findMany').mockImplementation(passthrough as never);
    try {
      const summary = await rec.runForZone(zoneId, { now: NOW, runId: await newRun() });
      // Eleven-odd candidates, one read. A per-ticket derivation would scale with the backlog on the
      // single hottest path in the system.
      expect(spy).toHaveBeenCalledTimes(1);
      // Guards against a vacuous pass: the run really did rank a multi-ticket backlog, half of it
      // return-due, and still went to the database once.
      expect(summary.ticketsConsidered).toBeGreaterThanOrEqual(6);
    } finally {
      spy.mockRestore();
    }
  });

  it('AC4 — no sla_bucket was modified to achieve priority', async () => {
    // The rejected alternative, pinned: promoting a bucket would be visible right here, on the stored
    // column that Fleet Uptime, the Soft Inactive Count and SLA reporting all read.
    const states = await prisma.deviceState.findMany({
      where: { deviceId: { in: deviceIds } },
      select: { deviceId: true, slaBucket: true },
    });
    expect(states.every((s) => s.slaBucket === 'CRITICAL' || s.slaBucket === 'RISK')).toBe(true);
    expect(states.filter((s) => s.slaBucket === 'CRITICAL')).toHaveLength(1);
  });
});
