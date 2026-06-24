import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 27 slice 2 — role backup HTTP. Operations Head / CSM mark role-unavailability; Operations Head
 * reads the per-zone CSM-backup share; lower roles are gated. Service logic is proven in
 * role-backup-service / csm-backup-report.
 */
describe('Issue 27 — role backup HTTP (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const markedIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.roleUnavailability.deleteMany({ where: { id: { in: markedIds } } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  it('Operations Head marks a ZM unavailable (201)', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/role-unavailability')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'ZONAL_MANAGER', zoneId: 1, windowStart: '2026-07-01T00:00:00Z', windowEnd: '2026-07-03T00:00:00Z', reason: 'leave' })
      .expect(201);
    expect(res.body.result).toBe('OK');
    markedIds.push(BigInt(res.body.id));
  });

  it('Operations Head reads the CSM backup share (200 array)', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/reports/csm-approval-share')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('forbids a ZM from marking role-unavailability and from the report (403)', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/role-unavailability')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'ZONAL_MANAGER', zoneId: 1, windowStart: '2026-07-01T00:00:00Z' })
      .expect(403);
    await request(app.getHttpServer()).get('/api/reports/csm-approval-share').set('Authorization', `Bearer ${token}`).expect(403);
  });
});
