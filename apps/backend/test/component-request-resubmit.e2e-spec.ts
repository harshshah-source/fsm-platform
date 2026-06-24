import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ComponentRequestService } from '../src/component-request/component-request.service';
import { TroubleshootSubmissionService } from '../src/ticketing/troubleshoot-submission.service';
import { type CoverageType, type DeliveryDestination } from '../src/generated/prisma/enums';

/**
 * Issue 22, slice 5 — the ZM-confirmed resubmit binding (ADR-0008, CONTEXT §8). On a RECEIVED request
 * the Zonal Manager confirms the resubmit: the primary SLA resumes (if still paused), the Failure Cycle
 * reopens WAITING_COMPONENT → OPEN, and resubmit ownership is computed — Dedicated/Multi-Plant keep soft
 * ownership of the original SE; a Floating SE depends on the spare's delivery destination (SE_LOCATION →
 * original SE, PLANT_WAREHOUSE → back to the open pool). The SE then resubmits the form with a NEW
 * client_submission_id on the same Ticket (one cycle → 1+ submissions).
 */
const NS = Date.now();
const PAUSED_AT = new Date('2026-06-24T07:00:00Z');
const NOW = new Date('2026-06-24T09:00:00Z');

describe('Issue 22 slice 5 — ZM-confirmed resubmit: ownership + reopen', () => {
  let prisma: PrismaService;
  let svc: ComponentRequestService;
  let submit: TroubleshootSubmissionService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let componentId: bigint;
  let zm: string;
  const seByCoverage = new Map<CoverageType, string>();
  const engineerIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const zmActor = () => ({ userId: zm, role: 'ZONAL_MANAGER' });

  const makeReceived = async (
    se: string,
    deliveryDestination: DeliveryDestination,
  ): Promise<{ requestId: string; cycleId: string; ticketId: string }> => {
    const deviceId = BigInt(11_900_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({
      data: {
        deviceId,
        state: 'WAITING_COMPONENT',
        openedAt: PAUSED_AT,
        slaPaused: true,
        slaPauseReason: 'WAITING_COMPONENT',
        slaPausedAt: PAUSED_AT,
        slaPauseSource: 'SE_COMPONENT_UNAVAILABLE',
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
        assignmentState: 'FORMALLY_ASSIGNED',
        lastStateChangedAt: PAUSED_AT,
      },
    });
    ticketIds.push(ticket.ticketId);
    const submission = await prisma.troubleshootingSubmission.create({
      data: {
        ticketId: ticket.ticketId,
        failureCycleId: cycle.cycleId,
        submissionType: 'TROUBLESHOOTING_FORM',
        clientSubmissionId: randomUUID(),
        seId: se,
        presenceSource: 'NONE',
        componentUnavailable: true,
        componentUnavailableItem: componentId,
        rootCauseCategory: 'GPS_ANTENNA_ISSUE',
        submittedAt: PAUSED_AT,
      },
    });
    const req = await prisma.componentRequest.create({
      data: {
        ticketId: ticket.ticketId,
        failureCycleId: cycle.cycleId,
        submissionId: submission.submissionId,
        seId: se,
        componentId,
        status: 'RECEIVED',
        deliveryDestination,
        shippedAt: PAUSED_AT,
        receivedAt: NOW,
      },
    });
    return { requestId: req.requestId, cycleId: cycle.cycleId, ticketId: ticket.ticketId };
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new ComponentRequestService(prisma);
    submit = new TroubleshootSubmissionService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-rs-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-rs-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-rs-' + NS, zoneId } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'cable-' + NS } })).componentId;

    for (const cov of ['DEDICATED', 'MULTI_PLANT', 'FLOATING'] as CoverageType[]) {
      const tag = randomUUID().slice(0, 8);
      const u = await prisma.user.create({
        data: { name: `SE ${cov} ${tag}`, role: 'SERVICE_ENGINEER', phone: 'se-' + tag, email: `se-${tag}@rs.test`, zoneId },
      });
      seByCoverage.set(cov, u.userId);
      engineerIds.push(u.userId);
      await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: cov, zoneId, dailyCapacity: 10 } });
    }
    const zmTag = randomUUID().slice(0, 8);
    const zmUser = await prisma.user.create({
      data: { name: 'ZM ' + zmTag, role: 'ZONAL_MANAGER', phone: 'zm-' + zmTag, email: `zm-${zmTag}@rs.test`, zoneId },
    });
    zm = zmUser.userId;
  });

  afterAll(async () => {
    await prisma.componentRequest.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'component_request' } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.componentMaster.deleteMany({ where: { componentId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: engineerIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: [...engineerIds, zm] } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('Dedicated SE keeps soft ownership; cycle reopens, SLA resumes, and a fresh form submits', async () => {
    const se = seByCoverage.get('DEDICATED')!;
    const { requestId, cycleId, ticketId } = await makeReceived(se, 'PLANT_WAREHOUSE');
    const out = await svc.confirmResubmit(requestId, zmActor(), NOW);
    expect(out.result).toBe('OK');
    expect(out.result === 'OK' && out.ownership.mode).toBe('SOFT_OWN_ORIGINAL');
    expect(out.result === 'OK' && out.ownership.seId).toBe(se);

    const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
    expect(cycle.state).toBe('OPEN');
    expect(cycle.slaPaused).toBe(false);
    expect(Number(cycle.slaAccumulatedPauseSeconds)).toBe(2 * 60 * 60);

    // The SE resubmits with a NEW client_submission_id on the SAME ticket → a second submission.
    const resubmit = await submit.submit({
      ticketId,
      seId: se,
      clientSubmissionId: randomUUID(),
      rootCauseCategory: 'GPS_ANTENNA_ISSUE',
      submissionType: 'COMPONENT_RESUBMIT',
      actor: { userId: se, role: 'SERVICE_ENGINEER' },
      now: NOW,
    });
    expect(resubmit.result).toBe('OK');
    const subs = await prisma.troubleshootingSubmission.findMany({ where: { failureCycleId: cycleId } });
    expect(subs.length).toBe(2);
  });

  it('Floating SE with spare at PLANT_WAREHOUSE returns the ticket to the open pool', async () => {
    const se = seByCoverage.get('FLOATING')!;
    const { requestId, ticketId } = await makeReceived(se, 'PLANT_WAREHOUSE');
    const out = await svc.confirmResubmit(requestId, zmActor(), NOW);
    expect(out.result === 'OK' && out.ownership.mode).toBe('RETURN_TO_POOL');
    expect(out.result === 'OK' && out.ownership.seId).toBeNull();
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.assignmentState).toBe('UNASSIGNED');
  });

  it('Floating SE with spare at SE_LOCATION keeps soft ownership of the original SE', async () => {
    const se = seByCoverage.get('FLOATING')!;
    const { requestId } = await makeReceived(se, 'SE_LOCATION');
    const out = await svc.confirmResubmit(requestId, zmActor(), NOW);
    expect(out.result === 'OK' && out.ownership.mode).toBe('SOFT_OWN_ORIGINAL');
    expect(out.result === 'OK' && out.ownership.seId).toBe(se);
  });

  it('refuses resubmit binding before the component is RECEIVED', async () => {
    const se = seByCoverage.get('MULTI_PLANT')!;
    const { requestId } = await makeReceived(se, 'SE_LOCATION');
    await prisma.componentRequest.update({ where: { requestId }, data: { status: 'SHIPPED' } });
    const out = await svc.confirmResubmit(requestId, zmActor(), NOW);
    expect(out.result).toBe('INVALID_STATE');
  });
});
