import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { TicketQueryService } from '../src/ticketing/ticket-query.service';

/**
 * Issue 23, slice 3 — the Ticket List flags WAITING_COMPONENT tickets. The list row carries
 * `waitingComponentSince` (the SLA-pause timestamp the UI turns into "days elapsed") and the latest
 * `componentRequestStatus`, so the Ticket List can render the amber WAITING_COMPONENT badge with the
 * Component Request status. Non-waiting tickets carry nulls.
 */
const NS = Date.now();
const NOW = new Date('2026-06-24T09:00:00Z');
const PAUSED_AT = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);

describe('Issue 23 slice 3 — ticket list WAITING_COMPONENT flag', () => {
  let prisma: PrismaService;
  let svc: TicketQueryService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let componentId: bigint;
  let se: string;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  let waitingTicketId = '';
  let plainTicketId = '';

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new TicketQueryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-twc-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-twc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-twc-' + NS, zoneId } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'cmp-twc-' + NS } })).componentId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'se-' + tag, email: `se-${tag}@twc.test`, zoneId } });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });

    // Waiting-component ticket (cycle WAITING_COMPONENT, SLA paused, a REQUESTED component request).
    const d1 = BigInt(12_400_000_000 + (NS % 100_000) * 10);
    deviceIds.push(d1);
    await prisma.device.create({ data: { deviceId: d1 } });
    const c1 = await prisma.failureCycle.create({
      data: { deviceId: d1, state: 'WAITING_COMPONENT', openedAt: PAUSED_AT, slaPaused: true, slaPauseReason: 'WAITING_COMPONENT', slaPausedAt: PAUSED_AT },
    });
    const t1 = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: c1.cycleId, deviceId: d1, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: PAUSED_AT },
    });
    waitingTicketId = t1.ticketId;
    ticketIds.push(t1.ticketId);
    const sub = await prisma.troubleshootingSubmission.create({
      data: { ticketId: t1.ticketId, failureCycleId: c1.cycleId, submissionType: 'TROUBLESHOOTING_FORM', clientSubmissionId: randomUUID(), seId: se, presenceSource: 'NONE', componentUnavailable: true, componentUnavailableItem: componentId, rootCauseCategory: 'GPS_ANTENNA_ISSUE', submittedAt: PAUSED_AT },
    });
    await prisma.componentRequest.create({
      data: { ticketId: t1.ticketId, failureCycleId: c1.cycleId, submissionId: sub.submissionId, seId: se, componentId, status: 'REQUESTED' },
    });

    // Plain OPEN ticket — no component request, not waiting.
    const d2 = BigInt(12_400_000_000 + (NS % 100_000) * 10 + 1);
    deviceIds.push(d2);
    await prisma.device.create({ data: { deviceId: d2 } });
    const c2 = await prisma.failureCycle.create({ data: { deviceId: d2, state: 'OPEN', openedAt: NOW } });
    const t2 = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: c2.cycleId, deviceId: d2, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW },
    });
    plainTicketId = t2.ticketId;
    ticketIds.push(t2.ticketId);
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
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('flags the WAITING_COMPONENT ticket with the pause timestamp and component-request status', async () => {
    const rows = await svc.list({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) }, { companyId: String(companyId) });
    const waiting = rows.find((r) => r.ticketId === waitingTicketId)!;
    expect(waiting.failureCycleState).toBe('WAITING_COMPONENT');
    expect(waiting.componentRequestStatus).toBe('REQUESTED');
    expect(waiting.waitingComponentSince).toBe(PAUSED_AT.toISOString());

    const plain = rows.find((r) => r.ticketId === plainTicketId)!;
    expect(plain.componentRequestStatus).toBeNull();
    expect(plain.waitingComponentSince).toBeNull();
  });
});
