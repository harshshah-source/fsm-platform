import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { TroubleshootSubmissionService } from '../src/ticketing/troubleshoot-submission.service';

/**
 * Issue 22, slice 2 — a Troubleshoot submit with `component_unavailable=true` is structurally different
 * from a normal submit (ADR-0008, CONTEXT §8): the Ticket stays OPEN, the Failure Cycle enters
 * WAITING_COMPONENT, the primary SLA pauses (pause_reason = WAITING_COMPONENT), and a Component Request
 * (REQUESTED) is raised for the Warehouse Manager. The raise is idempotent on the SE's
 * client_submission_id — a retry yields no second request and no second SLA pause.
 */
const NS = Date.now();
const NOW = new Date('2026-06-24T09:00:00Z');

describe('Issue 22 slice 2 — component-unavailable submit raises a request + pauses SLA', () => {
  let prisma: PrismaService;
  let svc: TroubleshootSubmissionService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let componentId: bigint;
  let se: string;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const actor = () => ({ userId: se, role: 'SERVICE_ENGINEER' });

  const makeTicket = async (): Promise<{ ticketId: string; cycleId: string }> => {
    const deviceId = BigInt(11_600_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
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
    return { ticketId: ticket.ticketId, cycleId: cycle.cycleId };
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new TroubleshootSubmissionService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-crr-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-crr-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-crr-' + NS, zoneId } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'antenna-' + NS } })).componentId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@crr.test`, zoneId },
    });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.componentRequest.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.componentMaster.deleteMany({ where: { componentId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('keeps the ticket OPEN, moves the cycle to WAITING_COMPONENT, pauses SLA, raises a request', async () => {
    const { ticketId, cycleId } = await makeTicket();

    const outcome = await svc.submit({
      ticketId,
      seId: se,
      clientSubmissionId: randomUUID(),
      rootCauseCategory: 'GPS_ANTENNA_ISSUE',
      componentUnavailable: true,
      componentUnavailableItem: componentId,
      actor: actor(),
      now: NOW,
    });
    expect(outcome.result).toBe('OK');

    // Ticket stays OPEN (VERIFICATION_PENDING_COMPONENT dropped — ADR-0008); cycle is WAITING_COMPONENT.
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('OPEN');
    const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
    expect(cycle.state).toBe('WAITING_COMPONENT');

    // Primary SLA pauses with the documented reason.
    expect(cycle.slaPaused).toBe(true);
    expect(cycle.slaPauseReason).toBe('WAITING_COMPONENT');
    expect(cycle.slaPausedAt?.toISOString()).toBe(NOW.toISOString());

    // A Component Request is raised for the warehouse, referencing the requested component + submission.
    const reqs = await prisma.componentRequest.findMany({ where: { ticketId } });
    expect(reqs.length).toBe(1);
    expect(reqs[0].status).toBe('REQUESTED');
    expect(reqs[0].seId).toBe(se);
    expect(reqs[0].componentId).toBe(componentId);
    expect(reqs[0].submissionId).toBe(outcome.result === 'OK' ? outcome.submission.submissionId : '');
  });

  it('is idempotent: a retry raises no second request and does not re-pause', async () => {
    const { ticketId, cycleId } = await makeTicket();
    const clientSubmissionId = randomUUID();
    const first = await svc.submit({
      ticketId,
      seId: se,
      clientSubmissionId,
      rootCauseCategory: 'GPS_ANTENNA_ISSUE',
      componentUnavailable: true,
      componentUnavailableItem: componentId,
      actor: actor(),
      now: NOW,
    });
    expect(first.result).toBe('OK');

    const second = await svc.submit({
      ticketId,
      seId: se,
      clientSubmissionId,
      rootCauseCategory: 'GPS_ANTENNA_ISSUE',
      componentUnavailable: true,
      componentUnavailableItem: componentId,
      actor: actor(),
      now: new Date('2026-06-24T10:00:00Z'),
    });
    expect(second.result).toBe('DUPLICATE');

    const reqs = await prisma.componentRequest.findMany({ where: { ticketId } });
    expect(reqs.length).toBe(1);
    const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
    expect(cycle.slaPausedAt?.toISOString()).toBe(NOW.toISOString()); // unchanged by the retry
  });

  it('normal submit (component available) still goes VERIFICATION_PENDING with no request', async () => {
    const { ticketId, cycleId } = await makeTicket();
    await svc.submit({
      ticketId,
      seId: se,
      clientSubmissionId: randomUUID(),
      rootCauseCategory: 'POWER_ISSUE',
      actor: actor(),
      now: NOW,
    });
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('VERIFICATION_PENDING');
    const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
    expect(cycle.state).toBe('SUBMITTED');
    expect(cycle.slaPaused).toBe(false);
    expect(await prisma.componentRequest.count({ where: { ticketId } })).toBe(0);
  });
});
