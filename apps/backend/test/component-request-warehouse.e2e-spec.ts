import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ComponentRequestService } from '../src/component-request/component-request.service';

/**
 * Issue 22, slice 3 — the Warehouse Manager flow (CONTEXT §Component Request, ADR-0008). The WM queue
 * lists active requests newest-first; the WM can Approve (REQUESTED → APPROVED), then Mark Shipped
 * (APPROVED → SHIPPED, with tracking + delivery destination), or Reject (REQUESTED → REJECTED, with a
 * mandatory reason). Out-of-order transitions are refused.
 */
const NS = Date.now();
const NOW = new Date('2026-06-24T09:00:00Z');

describe('Issue 22 slice 3 — warehouse manager component-request flow', () => {
  let prisma: PrismaService;
  let svc: ComponentRequestService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let componentId: bigint;
  let se: string;
  let wm: string;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const wmActor = () => ({ userId: wm, role: 'WAREHOUSE_MANAGER' });

  // Seed a REQUESTED component request directly (this slice tests the WM service, not the raise).
  const makeRequest = async (createdAt = NOW): Promise<string> => {
    const deviceId = BigInt(11_700_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'WAITING_COMPONENT', openedAt: NOW } });
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
        submittedAt: NOW,
      },
    });
    const req = await prisma.componentRequest.create({
      data: {
        ticketId: ticket.ticketId,
        failureCycleId: cycle.cycleId,
        submissionId: submission.submissionId,
        seId: se,
        componentId,
        status: 'REQUESTED',
        createdAt,
      },
    });
    return req.requestId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new ComponentRequestService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-wm-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-wm-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-wm-' + NS, zoneId } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'sim-' + NS } })).componentId;

    const tag = randomUUID().slice(0, 8);
    const seUser = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'se-' + tag, email: `se-${tag}@wm.test`, zoneId },
    });
    se = seUser.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    const wmUser = await prisma.user.create({
      data: { name: 'WM ' + tag, role: 'WAREHOUSE_MANAGER', phone: 'wm-' + tag, email: `wm-${tag}@wm.test`, zoneId },
    });
    wm = wmUser.userId;
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
    await prisma.user.deleteMany({ where: { userId: { in: [se, wm] } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('lists active requests newest-first with ticket / SE / component context', async () => {
    const older = await makeRequest(new Date('2026-06-24T08:00:00Z'));
    const newer = await makeRequest(new Date('2026-06-24T08:30:00Z'));
    const rows = await svc.queue();
    const ids = rows.map((r) => r.requestId);
    expect(ids).toContain(older);
    expect(ids).toContain(newer);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older)); // newest first
    const row = rows.find((r) => r.requestId === newer)!;
    expect(row.componentName).toBe('sim-' + NS);
    expect(row.zoneName).toBe('Z-wm-' + NS);
    expect(row.status).toBe('REQUESTED');
  });

  it('approves then marks shipped with tracking + delivery destination', async () => {
    const id = await makeRequest();
    const approved = await svc.approve(id, wmActor(), NOW);
    expect(approved.result).toBe('OK');
    expect(approved.result === 'OK' && approved.request.status).toBe('APPROVED');

    const shipped = await svc.markShipped(
      id,
      { trackingRef: 'TRK-123', deliveryDestination: 'PLANT_WAREHOUSE' },
      wmActor(),
      NOW,
    );
    expect(shipped.result).toBe('OK');
    expect(shipped.result === 'OK' && shipped.request.status).toBe('SHIPPED');
    expect(shipped.result === 'OK' && shipped.request.trackingRef).toBe('TRK-123');
    expect(shipped.result === 'OK' && shipped.request.deliveryDestination).toBe('PLANT_WAREHOUSE');

    const row = await prisma.componentRequest.findUniqueOrThrow({ where: { requestId: id } });
    expect(row.shippedAt?.toISOString()).toBe(NOW.toISOString());
    expect(row.wmActorId).toBe(wm);
  });

  it('rejects with a mandatory reason', async () => {
    const id = await makeRequest();
    const rejected = await svc.reject(id, 'OUT_OF_STOCK at zone warehouse', wmActor(), NOW);
    expect(rejected.result).toBe('OK');
    expect(rejected.result === 'OK' && rejected.request.status).toBe('REJECTED');
    expect(rejected.result === 'OK' && rejected.request.rejectionReason).toBe('OUT_OF_STOCK at zone warehouse');
  });

  it('refuses an out-of-order transition (ship before approve)', async () => {
    const id = await makeRequest();
    const shipped = await svc.markShipped(id, { trackingRef: 'X', deliveryDestination: 'SE_LOCATION' }, wmActor(), NOW);
    expect(shipped.result).toBe('INVALID_STATE');
    expect(shipped.result === 'INVALID_STATE' && shipped.status).toBe('REQUESTED');
  });

  it('returns NOT_FOUND for an unknown request', async () => {
    const out = await svc.approve(randomUUID(), wmActor(), NOW);
    expect(out.result).toBe('NOT_FOUND');
  });
});
