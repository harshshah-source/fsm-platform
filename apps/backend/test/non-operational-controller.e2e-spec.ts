import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 35, slice 4 — Non-Operational HTTP surface (`/api/non-op`). Managers request + manager-confirm;
 * the customer confirms via the public one-time token link; Operations-Head-only override. The request
 * path uses `@CurrentActor()`, so an Operations Head acting in a ZM's zone has `acted_as_role` audited.
 */
const DEV = 9_354_001n;

describe('Issue 35 slice 4 — /api/non-op (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.device.create({ data: { deviceId: DEV, dealType: 'ONE_TIME' } });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'non_operational_markings', entityId: String(DEV) } });
    await prisma.nonOperationalMarking.deleteMany({ where: { deviceId: DEV } });
    await prisma.device.deleteMany({ where: { deviceId: DEV } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  it('full flow: ZM requests → manager-confirm → customer token-confirm → CONFIRMED', async () => {
    const zm = await login('zm.north@fsm.test');

    const created = await request(app.getHttpServer())
      .post('/api/non-op')
      .set('Authorization', `Bearer ${zm}`)
      .send({ deviceId: String(DEV), reasonCode: 'COMPANY_PAUSED' })
      .expect(201);
    const markingId = created.body.markingId as string;
    expect(created.body.deviceId).toBe(String(DEV));
    expect(created.body.state).toBe('AWAITING_ZM_CONFIRMATION');

    const queue = await request(app.getHttpServer()).get('/api/non-op/queue').set('Authorization', `Bearer ${zm}`).expect(200);
    expect(queue.body.some((r: { markingId: string }) => r.markingId === markingId)).toBe(true);

    await request(app.getHttpServer()).post(`/api/non-op/${markingId}/confirm`).set('Authorization', `Bearer ${zm}`).expect(200);

    // customer leg — public, tokenised link (token read from the row the request created)
    const row = await prisma.nonOperationalMarking.findUniqueOrThrow({ where: { markingId } });
    await request(app.getHttpServer()).get(`/api/non-op/confirm?token=${row.customerToken}`).expect(200);

    const after = await prisma.nonOperationalMarking.findUniqueOrThrow({ where: { markingId } });
    expect(after.state).toBe('CONFIRMED');
  });

  it('forbids a Service Engineer from requesting, and a ZM from override-confirm', async () => {
    const se = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/non-op')
      .set('Authorization', `Bearer ${se}`)
      .send({ deviceId: String(DEV), reasonCode: 'COMPANY_PAUSED' })
      .expect(403);

    const zm = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/non-op/00000000-0000-0000-0000-0000000000aa/override-confirm')
      .set('Authorization', `Bearer ${zm}`)
      .send({ reason: 'x' })
      .expect(403);
  });

  it('an unknown customer token is 404 and a missing token is 400', async () => {
    await request(app.getHttpServer()).get('/api/non-op/confirm?token=nope').expect(404);
    await request(app.getHttpServer()).get('/api/non-op/confirm').expect(400);
  });

  it('Operations Head acting in a ZM zone has acted_as_role audited on the request', async () => {
    const oh = await login('ops.head@fsm.test');
    // device with no active marking — reuse a fresh one
    const dev2 = 9_354_002n;
    await prisma.device.create({ data: { deviceId: dev2, dealType: 'ONE_TIME' } });
    await request(app.getHttpServer())
      .post('/api/non-op')
      .set('Authorization', `Bearer ${oh}`)
      .set('X-Acting-As-Zone', '1')
      .send({ deviceId: String(dev2), reasonCode: 'COMPANY_PAUSED' })
      .expect(201);

    const audits = await prisma.auditLog.findMany({ where: { entityType: 'non_operational_markings', entityId: String(dev2), action: 'NON_OP_REQUESTED' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].actedAsRole).toBe('OPERATIONS_HEAD');
    expect(audits[0].actingZone).toBe(1n);

    await prisma.auditLog.deleteMany({ where: { entityType: 'non_operational_markings', entityId: String(dev2) } });
    await prisma.nonOperationalMarking.deleteMany({ where: { deviceId: dev2 } });
    await prisma.device.deleteMany({ where: { deviceId: dev2 } });
  });
});
