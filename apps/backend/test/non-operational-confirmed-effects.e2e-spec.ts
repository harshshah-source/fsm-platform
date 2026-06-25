import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { NonOperationalService } from '../src/ticketing/non-operational.service';
import type { RequestActor } from '../src/common/request-actor';
import type { $Enums } from '../src/generated/prisma/client';

/**
 * Issue 35, slice 3 — CONFIRMED side-effects (AC#3/#4/#5). Reaching CONFIRMED, in one transaction:
 * in-flight tickets auto-close as CLOSED_NON_OPERATIONAL (with a back-reference to the marking and a
 * lifecycle event), the device leaves the Fleet-Uptime eligible set (which also blocks new Failure
 * Cycles), and — only for a RECURRING device with a physical-retrieval reason — a RECOVERY ticket is
 * auto-created in REQUESTED and queued (its number returned for the toast).
 */
const DEV_RECURRING = 9_352_001n; // RECURRING + COMPANY_PAUSED → recovery ticket
const DEV_ONE_TIME = 9_352_002n; // ONE_TIME → no recovery ticket
const DEV_RECUR_NONQUAL = 9_352_003n; // RECURRING but COMPLIANCE_HOLD → no recovery ticket
const ALL = [DEV_RECURRING, DEV_ONE_TIME, DEV_RECUR_NONQUAL];

const zm: RequestActor = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null, actingZone: null };

describe('Issue 35 slice 3 — CONFIRMED side-effects', () => {
  let prisma: PrismaService;
  let service: NonOperationalService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;

  const NOW = new Date(Date.UTC(2026, 5, 25, 12, 0, 0));

  const seedDevice = async (deviceId: bigint, dealType: $Enums.DealType, withTicket: boolean) => {
    await prisma.device.create({ data: { deviceId, dealType } });
    await prisma.deviceState.create({
      data: { deviceId, eligibleForUptime: true, hasOpenFailureCycle: withTicket, plantId, companyId, computedAt: NOW },
    });
    if (withTicket) {
      const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
      const ticket = await prisma.ticket.create({
        data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW },
      });
      await prisma.ticketEvent.create({ data: { ticketId: ticket.ticketId, fromState: null, toState: 'OPEN', at: NOW } });
    }
  };

  const confirm = async (deviceId: bigint, reasonCode: $Enums.NonOpReason) => {
    const req = await service.requestMarking({ deviceId, reasonCode }, zm, NOW);
    if (req.result !== 'OK') throw new Error(req.result);
    await service.confirmByManager(req.marking.markingId, zm, NOW);
    await service.confirmByCustomer(req.marking.markingId, NOW);
    return req.marking.markingId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new NonOperationalService(prisma, new AuditService(prisma));
    zoneId = (await prisma.zone.create({ data: { name: 'Z-nope-' + Date.now() } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-nope-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-nope', zoneId } })).plantId;
    await seedDevice(DEV_RECURRING, 'RECURRING', true);
    await seedDevice(DEV_ONE_TIME, 'ONE_TIME', false);
    await seedDevice(DEV_RECUR_NONQUAL, 'RECURRING', false);
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'non_operational_markings' } });
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: { in: ALL } } } });
    await prisma.ticket.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.nonOperationalMarking.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('auto-closes the in-flight ticket, clears eligibility, and creates a RECOVERY ticket (RECURRING)', async () => {
    const markingId = await confirm(DEV_RECURRING, 'COMPANY_PAUSED');

    const closed = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_RECURRING, workType: 'TROUBLESHOOT' } });
    expect(closed.status).toBe('CLOSED_NON_OPERATIONAL');
    expect(closed.nonOpMarkingId).toBe(markingId);

    const events = await prisma.ticketEvent.findMany({ where: { ticketId: closed.ticketId }, orderBy: { at: 'asc' } });
    expect(events.at(-1)!.toState).toBe('CLOSED_NON_OPERATIONAL');

    const ds = await prisma.deviceState.findUniqueOrThrow({ where: { deviceId: DEV_RECURRING } });
    expect(ds.eligibleForUptime).toBe(false);
    expect(ds.hasOpenFailureCycle).toBe(false);

    const recovery = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_RECURRING, workType: 'RECOVERY' } });
    expect(recovery.status).toBe('REQUESTED');
    expect(recovery.assignmentState).toBe('UNASSIGNED');
    expect(recovery.nonOpMarkingId).toBe(markingId);

    const marking = await prisma.nonOperationalMarking.findUniqueOrThrow({ where: { markingId } });
    expect(marking.recoveryTicketId).toBe(recovery.ticketId);
  });

  it('does NOT create a Recovery ticket for a ONE_TIME device', async () => {
    const markingId = await confirm(DEV_ONE_TIME, 'COMPANY_PAUSED');
    expect(await prisma.ticket.count({ where: { deviceId: DEV_ONE_TIME, workType: 'RECOVERY' } })).toBe(0);
    expect((await prisma.nonOperationalMarking.findUniqueOrThrow({ where: { markingId } })).recoveryTicketId).toBeNull();
  });

  it('does NOT create a Recovery ticket for a non-qualifying reason (COMPLIANCE_HOLD)', async () => {
    await confirm(DEV_RECUR_NONQUAL, 'COMPLIANCE_HOLD');
    expect(await prisma.ticket.count({ where: { deviceId: DEV_RECUR_NONQUAL, workType: 'RECOVERY' } })).toBe(0);
  });
});
