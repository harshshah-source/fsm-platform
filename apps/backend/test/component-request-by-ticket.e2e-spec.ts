import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ComponentRequestService } from '../src/component-request/component-request.service';

/**
 * Issue 62 slice 1 — per-ticket Component Request read for the Ticket Detail **Components** tab.
 * `byTicket` returns ALL of a ticket's Component Requests (any status, newest-first) with component /
 * tracking / rejection / destination context, zone-scoped (ZM own-zone via the ticket's plant; CSM /
 * Operations Head all zones). Distinct from the WM queue (active-only) and the oversight list (zone-wide).
 */
const NS = Date.now();
const NOW = new Date('2026-06-25T09:00:00Z');

describe('Issue 62 slice 1 — ComponentRequestService.byTicket', () => {
  let prisma: PrismaService;
  let svc: ComponentRequestService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let componentId: bigint;
  let se: string;
  let ticketId: string;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new ComponentRequestService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-bt-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-bt-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-bt-' + NS, zoneId } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'antenna-' + NS } })).componentId;

    const tag = randomUUID().slice(0, 8);
    const seUser = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'bt-' + tag, email: `bt-${tag}@bt.test`, zoneId },
    });
    se = seUser.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });

    const deviceId = BigInt(11_800_000_000 + (NS % 100_000));
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
    ticketId = ticket.ticketId;
    ticketIds.push(ticketId);
    const submission = await prisma.troubleshootingSubmission.create({
      data: {
        ticketId,
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
    await prisma.componentRequest.create({
      data: {
        ticketId,
        failureCycleId: cycle.cycleId,
        submissionId: submission.submissionId,
        seId: se,
        componentId,
        status: 'SHIPPED',
        deliveryDestination: 'SE_LOCATION',
        trackingRef: 'TRK-62',
        createdAt: NOW,
      },
    });
  });

  afterAll(async () => {
    await prisma.componentRequest.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.componentMaster.deleteMany({ where: { componentId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('returns the ticket Component Request with component / tracking / destination context', async () => {
    const rows = await svc.byTicket(ticketId, { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) }, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('SHIPPED');
    expect(rows[0].componentName).toBe('antenna-' + NS);
    expect(rows[0].trackingRef).toBe('TRK-62');
    expect(rows[0].deliveryDestination).toBe('SE_LOCATION');
  });

  it('zone-scopes a ZM to their own zone (other-zone ZM sees nothing)', async () => {
    const rows = await svc.byTicket(ticketId, { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) + 999999 }, NOW);
    expect(rows).toHaveLength(0);
  });

  it('a cross-zone role (Operations Head) sees the request regardless of zone', async () => {
    const rows = await svc.byTicket(ticketId, { role: 'OPERATIONS_HEAD', zoneId: null }, NOW);
    expect(rows).toHaveLength(1);
  });
});
