import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { istDate } from '../src/common/ist-day';
import { PrismaService } from '../src/prisma/prisma.service';
import { VehicleReturnResumeService } from '../src/ticketing/vehicle-return-resume.service';
import { VehicleUnavailabilityService } from '../src/ticketing/vehicle-unavailability.service';

/**
 * #247 slice 2 (AC2/AC3/AC5) — the primary SLA resumes when the vehicle's return date arrives.
 *
 * Before this there were exactly two writers of `sla_paused = false` and **neither was date-driven**:
 * a ticket whose vehicle came back re-entered the dispatch pool on its return date (#246) with its
 * primary clock still frozen, so it could be planned, worked and closed while the one number the SLA
 * report grades never moved. The recycled ticket looked healthier the longer its vehicle had been away.
 *
 * The sweep is deliberately the *only* automatic resumer — `resumeSla` stays the manual path — and it
 * deliberately does **not** resolve the report (Decision 16): the SE may arrive and find the vehicle
 * absent again, and that next absence is a new report superseding this one, not a reopening.
 */
const NS = Date.now();
/** 10:00 IST on 2026-06-25. */
const NOW = new Date('2026-06-25T04:30:00Z');
/** Two hours before NOW — a pause interval of exactly 7200 s. */
const PAUSED_AT = new Date('2026-06-25T02:30:00Z');
/** 06:00 IST on the 25th — the return date has arrived, on today's IST day. */
const RETURN_TODAY = new Date('2026-06-25T00:30:00Z');
/** 09:00 IST on the 27th — two IST days out; the wait is still on. */
const RETURN_LATER = new Date('2026-06-27T03:30:00Z');

describe('#247 — auto-resume on the authoritative return date', () => {
  let prisma: PrismaService;
  let svc: VehicleReturnResumeService;
  let vu: VehicleUnavailabilityService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const cycleIds: string[] = [];

  /**
   * A ticket waiting on a vehicle: paused two hours ago, `UNASSIGNED`, deferred to the return day when
   * that day is still ahead — exactly the state `fileReport` leaves behind (#246).
   */
  async function waitingTicket(opts: {
    expectedFrom: Date;
    pauseReason?: 'VEHICLE_UNAVAILABLE' | 'WAITING_COMPONENT';
    paused?: boolean;
    status?: 'OPEN' | 'RESOLVED' | 'SUPERSEDED';
  }): Promise<{ ticketId: string; cycleId: string; reportId: string }> {
    const reason = opts.pauseReason ?? 'VEHICLE_UNAVAILABLE';
    const paused = opts.paused ?? true;
    const deviceId = String(9_920_000_000 + deviceIds.length + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
    deviceIds.push(deviceId);
    const cycle = await prisma.failureCycle.create({
      data: {
        deviceId,
        state: reason === 'WAITING_COMPONENT' ? 'WAITING_COMPONENT' : 'OPEN',
        openedAt: new Date('2026-06-25T00:30:00Z'),
        slaPaused: paused,
        slaPauseReason: paused ? reason : null,
        slaPausedAt: paused ? PAUSED_AT : null,
        slaPauseSource: paused ? (reason === 'WAITING_COMPONENT' ? 'SE_COMPONENT_UNAVAILABLE' : 'SE_VEHICLE_UNAVAILABLE') : null,
      },
    });
    const deferredUntil = istDate(opts.expectedFrom).getTime() > istDate(NOW).getTime() ? istDate(opts.expectedFrom) : null;
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        assignmentState: 'UNASSIGNED',
        deferredUntil,
        lastStateChangedAt: PAUSED_AT,
      },
    });
    ticketIds.push(ticket.ticketId);
    cycleIds.push(cycle.cycleId);
    const report = await prisma.vehicleUnavailabilityReport.create({
      data: {
        ticketId: ticket.ticketId,
        failureCycleId: cycle.cycleId,
        seId: se,
        reasonCode: 'VEHICLE_ON_TRIP',
        transporterContacted: false,
        proposedFrom: opts.expectedFrom,
        expectedFrom: opts.expectedFrom,
        status: opts.status ?? 'OPEN',
      },
    });
    return { ticketId: ticket.ticketId, cycleId: cycle.cycleId, reportId: String(report.id) };
  }

  const cycleRow = (cycleId: string) => prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
  const reportRow = (id: string) => prisma.vehicleUnavailabilityReport.findUniqueOrThrow({ where: { id: BigInt(id) } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new VehicleReturnResumeService(prisma);
    vu = new VehicleUnavailabilityService(prisma, new AuditService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-vu247s-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-vu247s-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-vu247s-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: {
        name: `SE ${tag}`,
        role: 'SERVICE_ENGINEER' as never,
        phone: `vu247s-${tag}`,
        email: `${tag}-${NS}@vu247s.test`,
        zoneId,
      },
    });
    userIds.push(u.userId);
    se = u.userId;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'failure_cycles', entityId: { in: cycleIds } } });
    await prisma.vehicleUnavailabilityReport.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('AC2/AC3 — the return date arrives: the clock restarts, the interval is folded in once, the report stays OPEN', async () => {
    const { ticketId, cycleId, reportId } = await waitingTicket({ expectedFrom: RETURN_TODAY });

    const out = await svc.sweepReturnedVehicles(NOW);
    expect(out.resumed).toBeGreaterThanOrEqual(1);

    const cycle = await cycleRow(cycleId);
    expect(cycle.slaPaused).toBe(false);
    expect(cycle.slaPauseReason).toBeNull();
    expect(cycle.slaPausedAt).toBeNull();
    expect(cycle.slaPauseSource).toBeNull();
    expect(Number(cycle.slaAccumulatedPauseSeconds)).toBe(7200);

    // AC3 — the report is NOT resolved. The vehicle being *due* back is not the same as the SE finding
    // it there, and a resolved report would erase the open question the queue exists to show.
    expect((await reportRow(reportId)).status).toBe('OPEN');
    expect((await reportRow(reportId)).resolvedAt).toBeNull();

    // AC4's other half, at the data level: the ticket really is selectable, and now with a live clock.
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.assignmentState).toBe('UNASSIGNED');
    expect(ticket.deferredUntil).toBeNull();

    // AC5 — the secondary clock is derived from `openedAt`, which nothing here touches.
    expect(cycle.openedAt.toISOString()).toBe('2026-06-25T00:30:00.000Z');

    // The auto-resume is attributable: a SYSTEM-actor row naming the cycle it restarted.
    const audits = await prisma.auditLog.findMany({ where: { entityType: 'failure_cycles', entityId: cycleId } });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe('SYSTEM');
    expect(audits[0].action).toBe('VU_SLA_AUTO_RESUMED');
  });

  it('AC2 — idempotent: a second sweep adds nothing, and a sweep after a manual resume is a no-op', async () => {
    const { cycleId } = await waitingTicket({ expectedFrom: RETURN_TODAY });
    await svc.sweepReturnedVehicles(NOW);
    const after = Number((await cycleRow(cycleId)).slaAccumulatedPauseSeconds);

    // An hour later the sweep runs again. The reason check finds nothing paused, so nothing accrues —
    // the failure this pins is the one that would silently double-count every night the report stays open.
    const later = new Date(NOW.getTime() + 3600_000);
    await svc.sweepReturnedVehicles(later);
    expect(Number((await cycleRow(cycleId)).slaAccumulatedPauseSeconds)).toBe(after);

    // Already-resumed-by-hand cycles are skipped for the same reason, through the same check.
    const manual = await waitingTicket({ expectedFrom: RETURN_TODAY, paused: false });
    await svc.sweepReturnedVehicles(NOW);
    expect(Number((await cycleRow(manual.cycleId)).slaAccumulatedPauseSeconds)).toBe(0);
    expect((await cycleRow(manual.cycleId)).slaPaused).toBe(false);
  });

  it('AC1 — a cycle component-paused during the wait is never touched by the sweep', async () => {
    const { cycleId } = await waitingTicket({ expectedFrom: RETURN_TODAY, pauseReason: 'WAITING_COMPONENT' });

    await svc.sweepReturnedVehicles(NOW);

    const cycle = await cycleRow(cycleId);
    expect(cycle.slaPaused).toBe(true);
    expect(cycle.slaPauseReason).toBe('WAITING_COMPONENT');
    expect(cycle.slaPausedAt?.toISOString()).toBe(PAUSED_AT.toISOString());
    expect(Number(cycle.slaAccumulatedPauseSeconds)).toBe(0);
  });

  it('AC2 — a report whose authoritative date is still ahead keeps its pause', async () => {
    const { cycleId } = await waitingTicket({ expectedFrom: RETURN_LATER });

    await svc.sweepReturnedVehicles(NOW);

    const cycle = await cycleRow(cycleId);
    expect(cycle.slaPaused).toBe(true);
    expect(cycle.slaPauseReason).toBe('VEHICLE_UNAVAILABLE');
    expect(Number(cycle.slaAccumulatedPauseSeconds)).toBe(0);

    // …and it resumes on the day itself, IST — the boundary the whole slice is keyed to.
    const onTheDay = new Date('2026-06-27T00:30:00Z'); // 06:00 IST on the 27th
    await svc.sweepReturnedVehicles(onTheDay);
    expect((await cycleRow(cycleId)).slaPaused).toBe(false);
  });

  it('AC2 — a superseded or resolved report is not a live wait and is never swept', async () => {
    const superseded = await waitingTicket({ expectedFrom: RETURN_TODAY, status: 'SUPERSEDED' });
    const resolved = await waitingTicket({ expectedFrom: RETURN_TODAY, status: 'RESOLVED' });

    await svc.sweepReturnedVehicles(NOW);

    expect((await cycleRow(superseded.cycleId)).slaPaused).toBe(true);
    expect((await cycleRow(resolved.cycleId)).slaPaused).toBe(true);
  });

  /**
   * AC5 — the two clocks stay two clocks. The secondary is true elapsed time from the Failure Cycle's
   * `opened_at` and is structurally unpausable (`toRow` derives it, nothing stores it); the sweep must
   * move the primary and leave it alone. Read through the service rather than off the columns, because
   * the criterion is about what a manager sees, not about which fields were written.
   */
  it('AC5 — the sweep moves the primary clock and leaves the secondary bit-identical', async () => {
    const { ticketId } = await waitingTicket({ expectedFrom: RETURN_TODAY });

    const before = (await vu.historyForTicket(ticketId, NOW))[0];
    await svc.sweepReturnedVehicles(NOW);
    const after = (await vu.historyForTicket(ticketId, NOW))[0];

    // openedAt 00:30Z -> NOW 04:30Z is four hours, paused or not.
    expect(before.secondarySlaSeconds).toBe(14400);
    expect(after.secondarySlaSeconds).toBe(before.secondarySlaSeconds);

    // The primary was frozen at two hours of running time and stays there at this instant — but it is
    // now *running*: the pause is closed and folded in, so it advances from here instead of standing
    // still for as long as the report happens to remain open.
    expect(before.slaPaused).toBe(true);
    expect(after.slaPaused).toBe(false);
    expect(after.primarySlaSeconds).toBe(before.primarySlaSeconds);
    const anHourOn = (await vu.historyForTicket(ticketId, new Date(NOW.getTime() + 3600_000)))[0];
    expect(anHourOn.primarySlaSeconds).toBe(after.primarySlaSeconds + 3600);
    expect(anHourOn.secondarySlaSeconds).toBe(before.secondarySlaSeconds + 3600);
  });
});
