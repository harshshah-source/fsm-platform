import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { VehicleUnavailabilityService } from '../src/ticketing/vehicle-unavailability.service';

/**
 * #247 slice 1 (AC1) — `resumeSla` must not clear a pause it did not cause.
 *
 * The hole is asymmetric, which is what made it invisible. `fileReport` guards with `!cycle.slaPaused`
 * and so refuses to re-pause an already-paused cycle, leaving whatever reason was standing; but
 * `resumeSla` guarded only on `slaPaused && slaPausedAt` and cleared the pause unconditionally. So a
 * manager resolving a vehicle report on a cycle that is waiting for a **component** silently restarted
 * the primary SLA on a ticket nobody can work — and the resume looked entirely ordinary, because the
 * report it was filed against really was open.
 *
 * Both orderings converge on the same state (`troubleshoot-submission.service.ts:186` overwrites the
 * pause columns with no guard of its own, so component-after-vehicle ends WAITING_COMPONENT too), so
 * the fixture writes the standing pause directly: the behaviour under test is the reason check, not
 * how the cycle came to be component-paused.
 */
const NS = Date.now();
const NOW = new Date('2026-06-25T04:30:00Z');
/** Two hours before NOW — a pause interval with an unambiguous 7200-second length. */
const PAUSED_AT = new Date('2026-06-25T02:30:00Z');

describe('#247 — reason-checked SLA resume', () => {
  let prisma: PrismaService;
  let svc: VehicleUnavailabilityService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let zm: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  /** A ticket whose Failure Cycle is already paused for `reason`, two hours ago. */
  async function pausedTicket(
    reason: 'VEHICLE_UNAVAILABLE' | 'WAITING_COMPONENT',
  ): Promise<{ ticketId: string; cycleId: string }> {
    const deviceId = String(9_910_000_000 + deviceIds.length + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
    deviceIds.push(deviceId);
    const cycle = await prisma.failureCycle.create({
      data: {
        deviceId,
        state: reason === 'WAITING_COMPONENT' ? 'WAITING_COMPONENT' : 'OPEN',
        openedAt: new Date('2026-06-25T00:30:00Z'),
        slaPaused: true,
        slaPauseReason: reason,
        slaPausedAt: PAUSED_AT,
        slaPauseSource: reason === 'WAITING_COMPONENT' ? 'SE_COMPONENT_UNAVAILABLE' : 'SE_VEHICLE_UNAVAILABLE',
      },
    });
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
        lastStateChangedAt: PAUSED_AT,
      },
    });
    ticketIds.push(ticket.ticketId);
    return { ticketId: ticket.ticketId, cycleId: cycle.cycleId };
  }

  /**
   * An OPEN report on the ticket, the vehicle back on `expectedFrom`. Written directly rather than
   * filed: filing would re-derive the pause, and these tests are about resuming one that already stands.
   */
  async function openReport(ticketId: string, cycleId: string, expectedFrom: Date): Promise<string> {
    const r = await prisma.vehicleUnavailabilityReport.create({
      data: {
        ticketId,
        failureCycleId: cycleId,
        seId: se,
        reasonCode: 'VEHICLE_ON_TRIP',
        transporterContacted: false,
        proposedFrom: expectedFrom,
        expectedFrom,
        status: 'OPEN',
      },
    });
    return String(r.id);
  }

  const cycleRow = (cycleId: string) => prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
  const manager = () => ({ userId: zm, role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new VehicleUnavailabilityService(prisma, new AuditService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-vu247-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-vu247-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-vu247-' + NS, zoneId } })).plantId;

    const mkUser = async (role: string) => {
      const tag = randomUUID().slice(0, 8);
      const u = await prisma.user.create({
        data: {
          name: `${role} ${tag}`,
          role: role as never,
          phone: `vu247-${tag}`,
          email: `${tag}-${NS}@vu247.test`,
          zoneId,
        },
      });
      userIds.push(u.userId);
      return u.userId;
    };
    se = await mkUser('SERVICE_ENGINEER');
    zm = await mkUser('ZONAL_MANAGER');
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
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

  it('AC1 — resuming a vehicle report on a component-paused cycle leaves the component pause standing', async () => {
    const { ticketId, cycleId } = await pausedTicket('WAITING_COMPONENT');
    const reportId = await openReport(ticketId, cycleId, NOW);

    const out = await svc.resumeSla(reportId, manager(), NOW);
    expect(out.result).toBe('OK');
    // The manager acted on the report, so the report resolves either way — what must not happen is the
    // clock restarting on a ticket that is still waiting for a part.
    expect(out).toMatchObject({ slaResumed: false });

    const cycle = await cycleRow(cycleId);
    expect(cycle.slaPaused).toBe(true);
    expect(cycle.slaPauseReason).toBe('WAITING_COMPONENT');
    expect(cycle.slaPausedAt?.toISOString()).toBe(PAUSED_AT.toISOString());
    expect(cycle.slaPauseSource).toBe('SE_COMPONENT_UNAVAILABLE');
    // Nothing folded in: the component pause never ended, so no interval closed.
    expect(Number(cycle.slaAccumulatedPauseSeconds)).toBe(0);

    const report = await prisma.vehicleUnavailabilityReport.findUniqueOrThrow({ where: { id: BigInt(reportId) } });
    expect(report.status).toBe('RESOLVED');
  });

  it('AC1 — resuming a vehicle report on a vehicle-paused cycle still resumes, folding in the interval', async () => {
    const { ticketId, cycleId } = await pausedTicket('VEHICLE_UNAVAILABLE');
    const reportId = await openReport(ticketId, cycleId, NOW);

    const out = await svc.resumeSla(reportId, manager(), NOW);
    expect(out).toMatchObject({ result: 'OK', slaResumed: true });

    const cycle = await cycleRow(cycleId);
    expect(cycle.slaPaused).toBe(false);
    expect(cycle.slaPauseReason).toBeNull();
    expect(cycle.slaPausedAt).toBeNull();
    expect(cycle.slaPauseSource).toBeNull();
    // PAUSED_AT → NOW is exactly two hours.
    expect(Number(cycle.slaAccumulatedPauseSeconds)).toBe(7200);
  });
});
