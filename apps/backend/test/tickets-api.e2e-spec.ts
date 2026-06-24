import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TicketCreationService } from '../src/ticketing/ticket-creation.service';

/**
 * Issue 05, slice 7 — the `/api/tickets/*` read surface (AC#6).
 *
 *  - GET /api/tickets      — ZM/CSM/OpsHead — the open-ticket list, each carrying its device's
 *                            stored SLA bucket (the "with the correct SLA bucket" clause).
 *  - GET /api/tickets/:id  — same roles — one ticket; 404 TICKET_NOT_FOUND otherwise.
 *  - SE is forbidden (SEs read work via the Day Plan / Shared Pool, not this manager surface).
 */
const DEVICE = 9_057_001n;

describe('Issue 05 slice 7 — /api/tickets', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let vehicleId: bigint;
  let ticketId: string;

  const NOW = new Date(Date.UTC(2026, 5, 20, 12, 0, 0));

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const zone = await prisma.zone.create({ data: { name: 'Z-slice7-' + Date.now() } });
    zoneId = zone.zoneId;
    const company = await prisma.company.create({
      data: { name: 'Co-slice7', companyTier: 'GOLD', companyPriorityRank: 'B' },
    });
    companyId = company.companyId;
    const plant = await prisma.plant.create({ data: { name: 'P-slice7', zoneId } });
    plantId = plant.plantId;
    const vehicle = await prisma.vehicle.create({
      data: { vehicleNo: 'VH-slice7-' + Date.now(), plantId, companyId },
    });
    vehicleId = vehicle.vehicleId;
    await prisma.device.create({ data: { deviceId: DEVICE, currentVehicleId: vehicleId } });
    await prisma.deviceState.create({
      data: {
        deviceId: DEVICE,
        isInactive: true,
        inactivityHours: 30,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: false,
        vehicleId,
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    await app.get(TicketCreationService).createForInactiveEligible(NOW);
    const t = await prisma.ticket.findFirst({ where: { deviceId: DEVICE } });
    ticketId = t!.ticketId;
  });

  afterAll(async () => {
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: DEVICE } } });
    await prisma.ticket.deleteMany({ where: { deviceId: DEVICE } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: DEVICE } });
    await prisma.deviceState.deleteMany({ where: { deviceId: DEVICE } });
    await prisma.device.deleteMany({ where: { deviceId: DEVICE } });
    await prisma.vehicle.deleteMany({ where: { vehicleId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  // Operations Head is cross-zone; ZM zone-scoping of the list landed in Issue 07 (see
  // tickets-list-detail.e2e-spec.ts), so this list assertion uses an all-zones role.
  it('lists the open ticket with its SLA bucket for Operations Head', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/tickets')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const mine = (res.body as Array<{ deviceId: string }>).find(
      (t) => t.deviceId === DEVICE.toString(),
    );
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({
      ticketId,
      workType: 'TROUBLESHOOT',
      status: 'OPEN',
      slaBucket: 'CRITICAL',
      companyTier: 'GOLD',
      plantId: plantId.toString(),
    });
  });

  it('returns one ticket by id', async () => {
    const token = await login('csm@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.ticketId).toBe(ticketId);
    expect(res.body.slaBucket).toBe('CRITICAL');
  });

  it('404s an unknown ticket id', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/tickets/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect(res.body.code).toBe('TICKET_NOT_FOUND');
  });

  it('forbids a Service Engineer', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/tickets')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/tickets').expect(401);
  });
});
