import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { istDate } from '../src/common/ist-day';
import { PrismaService } from '../src/prisma/prisma.service';
import { REMOVAL_REASONS } from '../src/scheduling/removal-reason';
import { notDeferredOn } from '../src/ticketing/deferral';
import { VehicleUnavailabilityService } from '../src/ticketing/vehicle-unavailability.service';

/**
 * #246 — the return date finally has consequences.
 *
 * Until now `expected_from` was stored and read by nothing in scheduling: the SE typed a date, the
 * ticket stayed `FORMALLY_ASSIGNED` on today's batch, and the next run planned it again as if the
 * vehicle were there. This slice connects the three: filing ends the attempt window
 * (`VEHICLE_UNAVAILABLE` + `UNASSIGNED`), the ticket waits until the authoritative IST day, and
 * re-entry happens through the predicate every unassigned-work reader already spreads in — no new
 * sweep, no new job.
 *
 * Decision 14 is the subtle half: the deferral is an **IST calendar day**, not an instant. A vehicle
 * back in two hours does not need a deferral at all — the ticket is simply eligible again, and
 * writing an hour-level wait would invent machinery nothing reads. Only a *later IST day* defers.
 * Decision 10 is the blunt half: no horizon, no cap. Management approval is the control.
 */
const NS = Date.now();
/** 10:00 IST on 2026-06-25 — mid-morning, so "later today" and "tomorrow" are both unambiguous. */
const NOW = new Date('2026-06-25T04:30:00Z');
const TODAY_IST = istDate(NOW);

describe('#246 — return-date deferral wiring: filing ends the attempt, the ticket waits', () => {
  let prisma: PrismaService;
  let svc: VehicleUnavailabilityService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let zm: string;
  let scheduleId: bigint;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const batchIds: bigint[] = [];

  /** A TROUBLESHOOT ticket sitting on a live day plan — the state a VU filing has to unwind. */
  async function assignedTicket(): Promise<string> {
    const deviceId = String(9_900_000_000 + deviceIds.length + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
    deviceIds.push(deviceId);
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
        assignmentState: 'FORMALLY_ASSIGNED',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId, plantId, seId: se, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    batchIds.push(batch.batchId);
    await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId: ticket.ticketId, sortOrder: 1 } });
    return ticket.ticketId;
  }

  const file = (ticketId: string, expectedFrom: Date) =>
    svc.fileReport(
      { ticketId, seId: se, reasonCode: 'VEHICLE_ON_TRIP', transporterContacted: false, expectedFrom },
      { userId: se, role: 'SERVICE_ENGINEER', zoneId: Number(zoneId) },
      NOW,
    );

  const ticketRow = (id: string) => prisma.ticket.findUniqueOrThrow({ where: { ticketId: id } });
  const liveRows = (ticketId: string) => prisma.batchAssignmentTicket.count({ where: { ticketId, removedAt: null } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new VehicleUnavailabilityService(prisma, new AuditService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-vu246-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-vu246-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-vu246-' + NS, zoneId } })).plantId;

    const mkUser = async (role: string) => {
      const tag = randomUUID().slice(0, 8);
      const u = await prisma.user.create({
        data: { name: `${role} ${tag}`, role: role as never, phone: `vu246-${tag}`, email: `${tag}-${NS}@vu246.test`, zoneId },
      });
      userIds.push(u.userId);
      return u.userId;
    };
    se = await mkUser('SERVICE_ENGINEER');
    zm = await mkUser('ZONAL_MANAGER');
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });

    scheduleId = (
      await prisma.workSchedule.create({
        data: { seId: se, zoneId, dateFrom: TODAY_IST, dateTo: TODAY_IST, status: 'ACTIVE', dispatchedAt: NOW },
      })
    ).scheduleId;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.workSchedule.deleteMany({ where: { scheduleId } });
    await prisma.vehicleUnavailabilityReport.deleteMany({ where: { ticketId: { in: ticketIds } } });
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

  // AC1 — the three writes that turn "the vehicle isn't here" into a finished attempt.
  it('AC1 — filing ends the attempt window and defers the ticket to the authoritative IST day', async () => {
    const ticketId = await assignedTicket();
    const tomorrow = new Date('2026-06-26T09:00:00Z');

    const out = await file(ticketId, tomorrow);
    expect(out.result).toBe('OK');

    const row = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { ticketId } });
    expect(row.removedAt).not.toBeNull();
    expect(row.removedBy).toBe(se);
    expect(row.removalReason).toBe(REMOVAL_REASONS.VEHICLE_UNAVAILABLE);
    expect(await liveRows(ticketId)).toBe(0);

    const ticket = await ticketRow(ticketId);
    // UNASSIGNED and deferred are a pair: without the first nothing can ever re-plan it, and without
    // the second it would be re-planned within the hour — which is the opposite of waiting.
    expect(ticket.assignmentState).toBe('UNASSIGNED');
    expect(ticket.deferredUntil?.toISOString()).toBe(istDate(tomorrow).toISOString());
  });

  // AC2 — Decision 14's four cases. A vehicle back before midnight needs no machinery at all.
  it('AC2 — same-IST-day returns write no deferral; only a later IST day defers', async () => {
    const cases: { label: string; at: Date; defers: boolean }[] = [
      { label: 'in 2 hours', at: new Date('2026-06-25T06:30:00Z'), defers: false },
      { label: 'later today (23:00 IST)', at: new Date('2026-06-25T17:30:00Z'), defers: false },
      { label: 'tomorrow morning', at: new Date('2026-06-26T03:30:00Z'), defers: true },
      { label: '25 August, two months out', at: new Date('2026-08-25T09:00:00Z'), defers: true },
    ];

    for (const c of cases) {
      const ticketId = await assignedTicket();
      await file(ticketId, c.at);
      const ticket = await ticketRow(ticketId);
      if (c.defers) {
        expect(ticket.deferredUntil?.toISOString(), c.label).toBe(istDate(c.at).toISOString());
      } else {
        expect(ticket.deferredUntil, c.label).toBeNull();
      }
      // The attempt ends either way — the vehicle was absent whether or not the ticket has to wait.
      expect(await liveRows(ticketId), c.label).toBe(0);
    }
  });

  // The one real subtlety the slice carries: the day is IST, not UTC. 19:00 UTC is already tomorrow
  // in IST, and bucketing it by UTC day would silently lose a day of waiting.
  it('AC2 — the IST boundary decides the day, not the UTC one', async () => {
    const ticketId = await assignedTicket();
    // 2026-06-25T19:00Z = 2026-06-26T00:30 IST — same UTC day as NOW, next IST day.
    const justPastIstMidnight = new Date('2026-06-25T19:00:00Z');
    await file(ticketId, justPastIstMidnight);

    const ticket = await ticketRow(ticketId);
    expect(ticket.deferredUntil?.toISOString()).toBe(new Date('2026-06-26T00:00:00.000Z').toISOString());
    expect(ticket.deferredUntil?.toISOString()).not.toBe(TODAY_IST.toISOString());
  });

  // AC3 — Decision 10. No horizon, no cap, no count. Management approval is the control.
  it('AC3 — a +90-day return date is accepted end to end, and repeat absences are not capped', async () => {
    const ticketId = await assignedTicket();
    const far = new Date(NOW.getTime() + 90 * 24 * 3600_000);
    const out = await file(ticketId, far);
    expect(out.result).toBe('OK');
    expect((await ticketRow(ticketId)).deferredUntil?.toISOString()).toBe(istDate(far).toISOString());

    // A second absence on the same ticket supersedes the first report and re-derives the wait —
    // nothing counts or refuses consecutive deferrals.
    const second = await file(ticketId, new Date(NOW.getTime() + 180 * 24 * 3600_000));
    expect(second.result).toBe('OK');
    const reports = await prisma.vehicleUnavailabilityReport.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } });
    expect(reports).toHaveLength(2);
    expect(reports[0].status).toBe('SUPERSEDED');
  });

  // AC4 — the wait always reflects the CURRENT authoritative date, including when that date moves
  // backwards into today and the wait should simply end.
  it('AC4 — approve, override and supersession each re-derive the deferral atomically', async () => {
    const ticketId = await assignedTicket();
    const filed = await file(ticketId, new Date('2026-06-28T09:00:00Z'));
    expect((await ticketRow(ticketId)).deferredUntil?.toISOString()).toBe(istDate(new Date('2026-06-28T09:00:00Z')).toISOString());

    // Approving keeps the SE's date — and therefore the wait it implies.
    await svc.approve(filed.id!, { userId: zm, role: 'ZONAL_MANAGER', zoneId: Number(zoneId) }, NOW);
    expect((await ticketRow(ticketId)).deferredUntil?.toISOString()).toBe(istDate(new Date('2026-06-28T09:00:00Z')).toISOString());

    // Overriding to a later date pushes the wait out…
    await svc.override(
      filed.id!,
      { expectedFrom: new Date('2026-07-02T09:00:00Z'), reason: 'yard shut all week' },
      { userId: zm, role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      NOW,
    );
    expect((await ticketRow(ticketId)).deferredUntil?.toISOString()).toBe(istDate(new Date('2026-07-02T09:00:00Z')).toISOString());

    // …and overriding back onto today ends it outright. A stale future date here would strand the
    // ticket for a week after the manager said the vehicle is back.
    await svc.override(
      filed.id!,
      { expectedFrom: new Date('2026-06-25T11:00:00Z'), reason: 'truck is back on site now' },
      { userId: zm, role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      NOW,
    );
    expect((await ticketRow(ticketId)).deferredUntil).toBeNull();
  });

  // AC5 — re-entry rides the existing inclusive predicate. Pinned as a real query, because the whole
  // design rests on "no new sweep": if the predicate does not select it, nothing ever will.
  it('AC5 — the ticket is excluded today and selected on exactly the authoritative day', async () => {
    const ticketId = await assignedTicket();
    const returnDay = new Date('2026-06-27T09:00:00Z');
    await file(ticketId, returnDay);

    const selectable = (day: Date) =>
      prisma.ticket.count({ where: { ticketId, status: 'OPEN', assignmentState: 'UNASSIGNED', ...notDeferredOn(day) } });

    expect(await selectable(TODAY_IST)).toBe(0);
    expect(await selectable(istDate(new Date('2026-06-26T09:00:00Z')))).toBe(0);
    // Inclusive on the deferred date itself — that is what "back on the 27th" has to mean.
    expect(await selectable(istDate(returnDay))).toBe(1);
    expect(await selectable(istDate(new Date('2026-06-28T09:00:00Z')))).toBe(1);
  });

  // AC7 — #244 counts an attempt from the window a removal closed. The removal reason is what makes
  // a VU visit countable as *reached but unsuccessful* rather than an administrative withdrawal.
  it('AC7 — the ended window is countable as one unsuccessful reached attempt', async () => {
    const ticketId = await assignedTicket();
    await file(ticketId, new Date('2026-06-26T09:00:00Z'));

    const windows = await prisma.batchAssignmentTicket.findMany({ where: { ticketId }, orderBy: { id: 'asc' } });
    expect(windows).toHaveLength(1);
    expect(windows[0].removalReason).toBe(REMOVAL_REASONS.VEHICLE_UNAVAILABLE);
    expect(windows[0].removedAt).not.toBeNull();

    // A second absence opens no new batch row by itself — the attempt count comes from windows that
    // were dispatched, so a re-dispatch is what creates the next one. Pinned so #244 reads one here.
    await file(ticketId, new Date('2026-06-29T09:00:00Z'));
    expect(await prisma.batchAssignmentTicket.count({ where: { ticketId } })).toBe(1);
  });

  // Filing on a ticket that is not on anyone's plan is normal (shared-pool work, or a ticket already
  // recycled) — it must still defer, and must not fail looking for a row that was never there.
  it('an unassigned ticket still defers, with no batch row to end', async () => {
    const ticketId = await assignedTicket();
    await prisma.batchAssignmentTicket.updateMany({
      where: { ticketId },
      data: { removedAt: NOW, removedBy: se, removalReason: REMOVAL_REASONS.ZM_WITHDRAWN },
    });
    await prisma.ticket.update({ where: { ticketId }, data: { assignmentState: 'UNASSIGNED' } });

    const out = await file(ticketId, new Date('2026-06-26T09:00:00Z'));
    expect(out.result).toBe('OK');
    expect((await ticketRow(ticketId)).deferredUntil?.toISOString()).toBe(istDate(new Date('2026-06-26T09:00:00Z')).toISOString());
    // The pre-existing removal reason is untouched — this filing ended no window of its own.
    const rows = await prisma.batchAssignmentTicket.findMany({ where: { ticketId } });
    expect(rows[0].removalReason).toBe(REMOVAL_REASONS.ZM_WITHDRAWN);
  });
});
