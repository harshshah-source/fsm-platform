import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SoftStateService } from '../src/soft-state/soft-state.service';

/**
 * Issue 15, slice 3 — ON_SITE source (AC#2). A deliberate app action that captures a location inside
 * the plant geofence auto-sets ON_SITE with `onsite_source = AUTO_GEOFENCE`; when location is off,
 * capture fails, or the SE is outside the fence, the SE's manual tap sets `onsite_source = MANUAL` and
 * is audited. The geofence is a configurable radius around the plant point (PostGIS ST_DWithin).
 */
const NS = Date.now();
const NOW = new Date('2026-06-23T07:00:00Z');
// Plant point (Bengaluru). Near ≈55 m away (inside the fence); far ≈55 km (outside).
const PLANT = { lat: 12.9716, lng: 77.5946 };
const NEAR = { lat: 12.9721, lng: 77.5946 };
const FAR = { lat: 13.4716, lng: 77.5946 };

describe('Issue 15 slice 3 — ON_SITE geofence vs manual source', () => {
  let prisma: PrismaService;
  let svc: SoftStateService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<string> => {
    const deviceId = BigInt(10_700_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
    return ticket.ticketId;
  };

  const actor = () => ({ userId: se, role: 'SERVICE_ENGINEER' });
  const manualAudits = (softStateId: bigint) =>
    prisma.auditLog.findMany({
      where: { action: 'SOFT_STATE_ONSITE_MANUAL', entityType: 'soft_states', entityId: String(softStateId) },
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new SoftStateService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-os3-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-os3-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-os3-' + NS, zoneId } })).plantId;
    await prisma.$executeRaw`UPDATE plants SET location = ST_SetSRID(ST_MakePoint(${PLANT.lng}, ${PLANT.lat}), 4326) WHERE plant_id = ${plantId}`;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@os3.test`, zoneId },
    });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { action: 'SOFT_STATE_ONSITE_MANUAL', actorId: se } });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('auto-sets ON_SITE as AUTO_GEOFENCE when the captured location is inside the plant fence (no audit)', async () => {
    const ticketId = await makeTicket();
    await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: NOW });

    const outcome = await svc.setOnSite({ ticketId, seId: se, capturedLocation: NEAR, actor: actor(), now: NOW });
    expect(outcome.result).toBe('OK');
    expect(outcome.result === 'OK' && outcome.softState.onsiteSource).toBe('AUTO_GEOFENCE');
    expect(outcome.result === 'OK' && (await manualAudits(outcome.softState.softStateId)).length).toBe(0);
  });

  it('falls back to MANUAL (audited) when the SE taps ON_SITE with no captured location', async () => {
    const ticketId = await makeTicket();
    await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: NOW });

    const outcome = await svc.setOnSite({ ticketId, seId: se, actor: actor(), now: NOW });
    expect(outcome.result).toBe('OK');
    expect(outcome.result === 'OK' && outcome.softState.onsiteSource).toBe('MANUAL');
    expect(outcome.result === 'OK' && (await manualAudits(outcome.softState.softStateId)).length).toBe(1);
  });

  it('falls back to MANUAL (audited) when the captured location is outside the plant fence', async () => {
    const ticketId = await makeTicket();
    await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: NOW });

    const outcome = await svc.setOnSite({ ticketId, seId: se, capturedLocation: FAR, actor: actor(), now: NOW });
    expect(outcome.result).toBe('OK');
    expect(outcome.result === 'OK' && outcome.softState.onsiteSource).toBe('MANUAL');
    expect(outcome.result === 'OK' && (await manualAudits(outcome.softState.softStateId)).length).toBe(1);
  });
});
