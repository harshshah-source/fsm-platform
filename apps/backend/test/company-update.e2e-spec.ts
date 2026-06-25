import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 46 — Company Update API. `PATCH /api/org/companies/:id` (Operations-Head-only, audited
 * `COMPANY_UPDATED`) updates tier / priority-rank / ops-override so a mis-tiered company is no longer
 * permanent (closes Issue 02 AC#3). Unknown id → 404; bad tier/rank → 400; non-Ops-Head → 403.
 */
const NS = Date.now();

describe('PATCH /api/org/companies/:id (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let companyId: number;
  const name = `Co-upd-${NS}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'company_master', entityId: name } });
    await prisma.company.deleteMany({ where: { name } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  it('create → update → list reflects the new tier / rank / override', async () => {
    const token = await login('ops.head@fsm.test');
    const created = await request(app.getHttpServer())
      .post('/api/org/companies')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, companyTier: 'SILVER', companyPriorityRank: 'C' })
      .expect(201);
    companyId = created.body.companyId;

    const updated = await request(app.getHttpServer())
      .patch(`/api/org/companies/${companyId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ companyTier: 'PLATINUM', companyPriorityRank: 'A', opsOverride: true })
      .expect(200);
    expect(updated.body.companyTier).toBe('PLATINUM');
    expect(updated.body.companyPriorityRank).toBe('A');
    expect(updated.body.opsOverride).toBe(true);

    const list = await request(app.getHttpServer()).get('/api/org/companies').set('Authorization', `Bearer ${token}`).expect(200);
    const row = list.body.find((c: { companyId: number }) => c.companyId === companyId);
    expect(row.companyTier).toBe('PLATINUM');
    expect(row.opsOverride).toBe(true);

    const audits = await prisma.auditLog.findMany({ where: { entityType: 'company_master', entityId: name, action: 'COMPANY_UPDATED' } });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('404s an unknown company and 400s a bad tier', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .patch('/api/org/companies/999999999')
      .set('Authorization', `Bearer ${token}`)
      .send({ companyTier: 'GOLD' })
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/org/companies/${companyId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ companyTier: 'DIAMOND' })
      .expect(400);
  });

  it('forbids a non-Operations-Head from updating (403)', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .patch(`/api/org/companies/${companyId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ companyTier: 'GOLD' })
      .expect(403);
  });
});
