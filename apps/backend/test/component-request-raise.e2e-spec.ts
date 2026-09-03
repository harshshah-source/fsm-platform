import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeCoverageService } from '../src/shared-pool/se-coverage.service';
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
  let cableId: bigint; // #352 — a second catalog part, the one the SE actually fitted on this visit
  let se: string;
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const actor = () => ({ userId: se, role: 'SERVICE_ENGINEER' });

  const makeTicket = async (): Promise<{ ticketId: string; cycleId: string }> => {
    const deviceId = String(11_600_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
    svc = new TroubleshootSubmissionService(prisma, new SeCoverageService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-crr-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-crr-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-crr-' + NS, zoneId } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'antenna-' + NS } })).componentId;
    cableId = (await prisma.componentMaster.create({ data: { name: 'cable-crr-' + NS } })).componentId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@crr.test`, zoneId },
    });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });
    await prisma.seVanStock.create({ data: { seId: se, componentId: cableId, qty: 5 } });
  });

  afterAll(async () => {
    await prisma.seCoverage.deleteMany({ where: { seId: se } });
    await prisma.inventoryTransaction.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.seVanStock.deleteMany({ where: { seId: se } });
    await prisma.componentRequest.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.componentMaster.deleteMany({ where: { componentId: { in: [componentId, cableId] } } });
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

  // -----------------------------------------------------------------------------------------------
  // #352 — the raise is only reachable if the request can name the component. These are the refusals
  // that used to be a CHECK-constraint 500 (no submission, no request, an empty warehouse queue and
  // nothing in the response saying why).
  // -----------------------------------------------------------------------------------------------

  it('#352 — component-unavailable with no item is COMPONENT_ITEM_REQUIRED, and writes nothing', async () => {
    const { ticketId, cycleId } = await makeTicket();
    const outcome = await svc.submit({
      ticketId,
      seId: se,
      clientSubmissionId: randomUUID(),
      rootCauseCategory: 'GPS_ANTENNA_ISSUE',
      componentUnavailable: true,
      actor: actor(),
      now: NOW,
    });
    expect(outcome.result).toBe('COMPONENT_ITEM_REQUIRED');
    expect(await prisma.troubleshootingSubmission.count({ where: { ticketId } })).toBe(0);
    expect(await prisma.componentRequest.count({ where: { ticketId } })).toBe(0);
    // The cycle is untouched: a refused submission must not leave the SLA paused on a raise that
    // never happened.
    const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
    expect(cycle.state).toBe('OPEN');
    expect(cycle.slaPaused).toBe(false);
  });

  it('#352 — an item naming no catalog row is UNKNOWN_COMPONENT, not an FK failure', async () => {
    const { ticketId } = await makeTicket();
    const outcome = await svc.submit({
      ticketId,
      seId: se,
      clientSubmissionId: randomUUID(),
      rootCauseCategory: 'GPS_ANTENNA_ISSUE',
      componentUnavailable: true,
      componentUnavailableItem: 999_999_999n,
      actor: actor(),
      now: NOW,
    });
    expect(outcome.result).toBe('UNKNOWN_COMPONENT');
    expect(outcome.result === 'UNKNOWN_COMPONENT' && outcome.componentIds).toEqual(['999999999']);
    expect(await prisma.troubleshootingSubmission.count({ where: { ticketId } })).toBe(0);
  });

  it('#352 — parts fitted on a component-unavailable visit still reach the ledger', async () => {
    // "One component was unavailable" is not "nothing was fitted". Before #352 the consumption loop
    // ran only on the normal path, so these two cables left the van and never left the books.
    const { ticketId } = await makeTicket();
    const before = (await prisma.seVanStock.findUniqueOrThrow({ where: { seId_componentId: { seId: se, componentId: cableId } } })).qty;
    const outcome = await svc.submit({
      ticketId,
      seId: se,
      clientSubmissionId: randomUUID(),
      rootCauseCategory: 'WIRING_ISSUE',
      componentUnavailable: true,
      componentUnavailableItem: componentId,
      consumedComponents: [{ componentId: cableId, qty: 2 }],
      actor: actor(),
      now: NOW,
    });
    expect(outcome.result).toBe('OK');

    expect(await prisma.componentRequest.count({ where: { ticketId } })).toBe(1); // the raise still happens
    const txns = await prisma.inventoryTransaction.findMany({ where: { ticketId, seId: se } });
    expect(txns).toHaveLength(1);
    expect(txns[0].componentId).toBe(cableId);
    expect(txns[0].status).toBe('PRE_VERIFICATION');
    const after = (await prisma.seVanStock.findUniqueOrThrow({ where: { seId_componentId: { seId: se, componentId: cableId } } })).qty;
    expect(after).toBe(before - 2);
  });
});
