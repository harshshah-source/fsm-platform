import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 07, slice B — the `/api/tickets` list filters + bucket-descending sort + zone scoping, and
 * the `/api/tickets/:id` detail lifecycle (AC#1/#2/#5/#6).
 */
const ZM_ZONE = 1;
const D1 = 9_072_001n; // zone 1, CRITICAL
const D2 = 9_072_002n; // zone 1, WARNING, repeat
const D3 = 9_072_003n; // other zone, LONG_PENDING
const ALL = [D1, D2, D3];

describe('Issue 07 slice B — /api/tickets list + detail', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let otherZoneId: bigint;
  let companyId: bigint;
  let plant1: bigint;
  let plant2: bigint;
  const ticketByDevice = new Map<bigint, string>();

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const seedTicket = async (
    deviceId: bigint,
    plantId: bigint,
    bucket: string,
    opts: { repeat?: boolean } = {},
  ) => {
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        inactivityHours: 50,
        slaBucket: bucket as never,
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        plantId,
        companyId,
        computedAt: new Date(),
      },
    });
    const cycle = await prisma.failureCycle.create({
      data: { deviceId, state: 'OPEN', openedAt: new Date() },
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
        repeatFailure: opts.repeat ?? false,
        lastStateChangedAt: new Date(),
      },
    });
    ticketByDevice.set(deviceId, ticket.ticketId);
    await prisma.ticketEvent.create({
      data: { ticketId: ticket.ticketId, fromState: null, toState: 'OPEN' },
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const other = await prisma.zone.create({ data: { name: 'Z-ld-' + Date.now() } });
    otherZoneId = other.zoneId;
    const company = await prisma.company.create({
      data: { name: 'Co-ld-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'B' },
    });
    companyId = company.companyId;
    plant1 = (await prisma.plant.create({ data: { name: 'P1-ld', zoneId: BigInt(ZM_ZONE) } })).plantId;
    plant2 = (await prisma.plant.create({ data: { name: 'P2-ld', zoneId: otherZoneId } })).plantId;

    await seedTicket(D1, plant1, 'CRITICAL');
    await seedTicket(D2, plant1, 'WARNING', { repeat: true });
    await seedTicket(D3, plant2, 'LONG_PENDING');
  });

  afterAll(async () => {
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: { in: ALL } } } });
    await prisma.ticket.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plant1, plant2] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: otherZoneId } });
    await app.close();
  });

  const mineInOrder = (body: Array<{ deviceId: string }>): string[] =>
    body.map((t) => t.deviceId).filter((d) => ALL.map(String).includes(d));

  it('defaults to SLA-bucket-descending order', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/tickets')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    // LONG_PENDING (D3) > CRITICAL (D1) > WARNING (D2)
    expect(mineInOrder(res.body)).toEqual([D3.toString(), D1.toString(), D2.toString()]);
  });

  it('filters by SLA bucket', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/tickets?bucket=CRITICAL')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(mineInOrder(res.body)).toEqual([D1.toString()]);
  });

  it('filters by work type', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/tickets?workType=RECOVERY')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(mineInOrder(res.body)).toEqual([]);
  });

  it('scopes a Zonal Manager to their own zone', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/tickets')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const mine = mineInOrder(res.body);
    expect(mine).toContain(D1.toString());
    expect(mine).toContain(D2.toString());
    expect(mine).not.toContain(D3.toString()); // other zone
  });

  it('returns the lifecycle on the detail endpoint', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/tickets/${ticketByDevice.get(D1)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.lifecycle).toHaveLength(1);
    expect(res.body.lifecycle[0].toState).toBe('OPEN');
    expect(res.body.lifecycle[0].fromState).toBeNull();
  });

  it('404s a ZM opening a ticket outside their zone', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .get(`/api/tickets/${ticketByDevice.get(D3)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});
