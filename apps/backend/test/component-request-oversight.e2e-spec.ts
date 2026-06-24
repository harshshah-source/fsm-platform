import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ComponentRequestService } from '../src/component-request/component-request.service';

/**
 * Issue 23, slice 1 — manager read-only oversight of Component Requests (CONTEXT §Component Request:
 * "Zonal Manager visibility (read-only)"). A ZM sees only their own zone's requests; CSM / Operations
 * Head see all zones. Rows carry component, ticket/device, the raising SE, status, WM action, and age —
 * visibility only, no stock-movement actions.
 */
const NS = Date.now();
const NOW = new Date('2026-06-24T09:00:00Z');

describe('Issue 23 slice 1 — component request oversight (zone-scoped read)', () => {
  let prisma: PrismaService;
  let svc: ComponentRequestService;

  const zones: Record<'A' | 'B', bigint> = { A: 0n, B: 0n };
  let companyId: bigint;
  let componentId: bigint;
  let se: string;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const reqByZone: Record<'A' | 'B', string> = { A: '', B: '' };

  const seedRequest = async (zoneKey: 'A' | 'B'): Promise<string> => {
    const zoneId = zones[zoneKey];
    const plantId = (await prisma.plant.create({ data: { name: `P-ov-${zoneKey}-${NS}`, zoneId } })).plantId;
    const deviceId = BigInt(12_200_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'WAITING_COMPONENT', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId,
        plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    const submission = await prisma.troubleshootingSubmission.create({
      data: {
        ticketId: ticket.ticketId, failureCycleId: cycle.cycleId, submissionType: 'TROUBLESHOOTING_FORM',
        clientSubmissionId: randomUUID(), seId: se, presenceSource: 'NONE', componentUnavailable: true,
        componentUnavailableItem: componentId, rootCauseCategory: 'GPS_ANTENNA_ISSUE', submittedAt: NOW,
      },
    });
    const req = await prisma.componentRequest.create({
      data: {
        ticketId: ticket.ticketId, failureCycleId: cycle.cycleId, submissionId: submission.submissionId,
        seId: se, componentId, status: 'REQUESTED',
      },
    });
    return req.requestId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new ComponentRequestService(prisma);

    zones.A = (await prisma.zone.create({ data: { name: 'Z-ovA-' + NS } })).zoneId;
    zones.B = (await prisma.zone.create({ data: { name: 'Z-ovB-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-ov-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'ant-ov-' + NS } })).componentId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'se-' + tag, email: `se-${tag}@ov.test`, zoneId: zones.A } });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId: zones.A, dailyCapacity: 10 } });

    reqByZone.A = await seedRequest('A');
    reqByZone.B = await seedRequest('B');
  });

  afterAll(async () => {
    await prisma.componentRequest.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.componentMaster.deleteMany({ where: { componentId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.plant.deleteMany({ where: { zoneId: { in: [zones.A, zones.B] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zones.A, zones.B] } } });
    await prisma.onModuleDestroy();
  });

  it('scopes a Zonal Manager to their own zone', async () => {
    const rows = await svc.oversightQueue({ role: 'ZONAL_MANAGER', zoneId: Number(zones.A) });
    const ids = rows.map((r) => r.requestId);
    expect(ids).toContain(reqByZone.A);
    expect(ids).not.toContain(reqByZone.B);
    // Read-only rows carry the oversight fields.
    const row = rows.find((r) => r.requestId === reqByZone.A)!;
    expect(row.componentName).toBe('ant-ov-' + NS);
    expect(row.seId).toBe(se);
    expect(row.status).toBe('REQUESTED');
  });

  it('shows all zones to Central Service Manager and Operations Head', async () => {
    for (const role of ['CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']) {
      const rows = await svc.oversightQueue({ role, zoneId: null });
      const ids = rows.map((r) => r.requestId);
      expect(ids).toContain(reqByZone.A);
      expect(ids).toContain(reqByZone.B);
    }
  });
});
