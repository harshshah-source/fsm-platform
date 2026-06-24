import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ComponentRequestService } from '../src/component-request/component-request.service';

/**
 * Issue 22, slice 4 — SE Confirm Receipt (CONTEXT §Component Request §8). A SHIPPED request the SE
 * confirms moves to RECEIVED. Whether the primary SLA resumes at receipt is governed by the
 * `sla_resume_on_receipt` switch: ON → resume now (accumulate paused seconds, clear the pause); OFF
 * (default, per ADR-0008) → stay paused until the ZM-confirmed resubmit (slice 5).
 */
const NS = Date.now();
const PAUSED_AT = new Date('2026-06-24T07:00:00Z');
const NOW = new Date('2026-06-24T09:00:00Z'); // 2h after pause

describe('Issue 22 slice 4 — SE confirm receipt + SLA resume switch', () => {
  let prisma: PrismaService;
  let svc: ComponentRequestService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let componentId: bigint;
  let se: string;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const seActor = () => ({ userId: se, role: 'SERVICE_ENGINEER' });

  // Seed a SHIPPED request whose cycle is WAITING_COMPONENT with SLA paused at PAUSED_AT.
  const makeShipped = async (): Promise<{ requestId: string; cycleId: string }> => {
    const deviceId = BigInt(11_800_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
        status: 'SHIPPED',
        shippedAt: PAUSED_AT,
        trackingRef: 'TRK',
        deliveryDestination: 'PLANT_WAREHOUSE',
      },
    });
    return { requestId: req.requestId, cycleId: cycle.cycleId };
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new ComponentRequestService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-rc-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-rc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-rc-' + NS, zoneId } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'fuse-' + NS } })).componentId;

    const tag = randomUUID().slice(0, 8);
    const seUser = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'se-' + tag, email: `se-${tag}@rc.test`, zoneId },
    });
    se = seUser.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.componentRequest.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'component_request' } });
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

  it('confirms receipt: SHIPPED → RECEIVED with received_at', async () => {
    const { requestId } = await makeShipped();
    const out = await svc.confirmReceipt(requestId, seActor(), { now: NOW });
    expect(out.result).toBe('OK');
    expect(out.result === 'OK' && out.request.status).toBe('RECEIVED');
    const row = await prisma.componentRequest.findUniqueOrThrow({ where: { requestId } });
    expect(row.receivedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('resumes SLA at receipt when the switch is ON (accumulates paused seconds)', async () => {
    const { requestId, cycleId } = await makeShipped();
    await svc.confirmReceipt(requestId, seActor(), { now: NOW, resumeOnReceipt: true });
    const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
    expect(cycle.slaPaused).toBe(false);
    expect(cycle.slaPauseReason).toBeNull();
    expect(cycle.slaPausedAt).toBeNull();
    expect(Number(cycle.slaAccumulatedPauseSeconds)).toBe(2 * 60 * 60); // 2h paused
  });

  it('keeps SLA paused at receipt when the switch is OFF (default — resume binds at resubmit)', async () => {
    const { requestId, cycleId } = await makeShipped();
    await svc.confirmReceipt(requestId, seActor(), { now: NOW, resumeOnReceipt: false });
    const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
    expect(cycle.slaPaused).toBe(true);
    expect(cycle.slaPauseReason).toBe('WAITING_COMPONENT');
  });

  it('refuses confirm-receipt on a not-yet-shipped request', async () => {
    const { requestId } = await makeShipped();
    await prisma.componentRequest.update({ where: { requestId }, data: { status: 'REQUESTED' } });
    const out = await svc.confirmReceipt(requestId, seActor(), { now: NOW });
    expect(out.result).toBe('INVALID_STATE');
  });
});
