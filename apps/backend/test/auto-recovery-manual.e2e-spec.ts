import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 08, slice 3 — a ZM manually marks a Ticket CLOSED_AUTO_RECOVERY (AC#3). Zone-scoped; the
 * lifecycle event records the acting manager; a second attempt 409s (no longer open).
 */
const ZM_ZONE = 1;
const DEV_ZM = 9_082_001n;
const DEV_OTHER = 9_082_002n;
const ALL = [DEV_ZM, DEV_OTHER];

describe('Issue 08 slice 3 — manual auto-recovery close', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let otherZoneId: bigint;
  let companyId: bigint;
  let plantZm: bigint;
  let plantOther: bigint;
  const ticketByDevice = new Map<bigint, string>();

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const seedOpen = async (deviceId: bigint, plantId: bigint) => {
    await prisma.device.create({ data: { deviceId } });
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
        lastStateChangedAt: new Date(),
      },
    });
    await prisma.deviceState.create({
      data: { deviceId, isInactive: true, eligibleForUptime: true, hasOpenFailureCycle: true, plantId, companyId, computedAt: new Date() },
    });
    ticketByDevice.set(deviceId, ticket.ticketId);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    otherZoneId = (await prisma.zone.create({ data: { name: 'Z-arm-' + Date.now() } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-arm', companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantZm = (await prisma.plant.create({ data: { name: 'P-zm-arm', zoneId: BigInt(ZM_ZONE) } })).plantId;
    plantOther = (await prisma.plant.create({ data: { name: 'P-other-arm', zoneId: otherZoneId } })).plantId;

    await seedOpen(DEV_ZM, plantZm);
    await seedOpen(DEV_OTHER, plantOther);
  });

  afterAll(async () => {
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: { in: ALL } } } });
    await prisma.ticket.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantZm, plantOther] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: otherZoneId } });
    await app.close();
  });

  it('lets a Zonal Manager close an own-zone ticket as auto-recovery, recording the actor', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketByDevice.get(DEV_ZM)}/auto-recovery-close`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.status).toBe('CLOSED_AUTO_RECOVERY');

    const ticket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_ZM } });
    expect(ticket.status).toBe('CLOSED_AUTO_RECOVERY');
    const last = await prisma.ticketEvent.findFirstOrThrow({
      where: { ticket: { deviceId: DEV_ZM } },
      orderBy: { at: 'desc' },
    });
    expect(last.toState).toBe('CLOSED_AUTO_RECOVERY');
    expect(last.actorRole).toBe('ZONAL_MANAGER');
  });

  it('409s a second close of an already-closed ticket', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post(`/api/tickets/${ticketByDevice.get(DEV_ZM)}/auto-recovery-close`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });

  it('404s a ZM closing a ticket outside their zone', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post(`/api/tickets/${ticketByDevice.get(DEV_OTHER)}/auto-recovery-close`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('forbids a Service Engineer', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post(`/api/tickets/${ticketByDevice.get(DEV_OTHER)}/auto-recovery-close`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
