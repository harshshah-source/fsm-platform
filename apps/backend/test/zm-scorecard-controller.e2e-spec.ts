import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 43 slice 3 — `/api/reports/zm-scorecard` HTTP surface. Operations Head recomputes a month, then
 * reads the ZM-wise comparison. Gated to OPERATIONS_HEAD **only** — never the ZM (the scorecard is not
 * shown to ZMs and ZMs never enter their own scores), and not CSM or SE. Seeded: a ZM in zone 1 with two
 * audited override actions in May.
 */
const NS = Date.now();

describe('Issue 43 slice 3 — /api/reports/zm-scorecard (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zmId: string;
  const userIds: string[] = [];
  const auditIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    await prisma.zone.upsert({ where: { zoneId: 1n }, update: {}, create: { zoneId: 1n, name: 'Zone-1-seed' } });
    const t = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'ZM scc ' + t, role: 'ZONAL_MANAGER', phone: 'scc-' + t, email: `scc-${t}@scc.test`, zoneId: 1n } });
    zmId = u.userId;
    userIds.push(zmId);
    const may5 = new Date(Date.UTC(2026, 4, 5));
    for (let i = 0; i < 2; i++) {
      const row = await prisma.auditLog.create({
        data: { actorId: zmId, actorRole: 'ZONAL_MANAGER', action: 'BATCH_OVERRIDE_REMOVE_TICKET', entityType: 'plant_batch_assignment', entityId: String(NS + i), createdAt: may5 },
      });
      auditIds.push(row.id);
    }
  });

  afterAll(async () => {
    await prisma.zmPerformanceSummaryMonthly.deleteMany({ where: { zmId } });
    await prisma.auditLog.deleteMany({ where: { id: { in: auditIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  it('Operations Head recomputes May, then the scorecard shows the ZM’s overrides', async () => {
    const oh = await login('ops.head@fsm.test');
    const recompute = await request(app.getHttpServer())
      .post('/api/reports/zm-scorecard/recompute?month=2026-05')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
    expect(recompute.body.month).toBe('2026-05-01');
    expect(recompute.body.zms).toBeGreaterThanOrEqual(1);

    const report = await request(app.getHttpServer())
      .get('/api/reports/zm-scorecard?from=2026-05&to=2026-05&zoneId=1')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
    const mine = report.body.rows.find((r: { zmId: string }) => r.zmId === zmId);
    expect(mine.overrides).toBe(2);
    expect(mine.removals).toBe(2);
  });

  it('forbids the ZM from seeing the scorecard (403) — never shown to the ZM', async () => {
    const zm = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).get('/api/reports/zm-scorecard?from=2026-05&to=2026-05').set('Authorization', `Bearer ${zm}`).expect(403);
  });

  it('forbids a CSM and a Service Engineer (403)', async () => {
    const csm = await login('csm@fsm.test');
    await request(app.getHttpServer()).get('/api/reports/zm-scorecard?from=2026-05').set('Authorization', `Bearer ${csm}`).expect(403);
    const se = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/reports/zm-scorecard?from=2026-05').set('Authorization', `Bearer ${se}`).expect(403);
  });

  it('forbids a ZM from triggering recompute (403)', async () => {
    const zm = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).post('/api/reports/zm-scorecard/recompute?month=2026-05').set('Authorization', `Bearer ${zm}`).expect(403);
  });

  it('rejects an invalid month (400)', async () => {
    const oh = await login('ops.head@fsm.test');
    await request(app.getHttpServer()).get('/api/reports/zm-scorecard?from=2026-13').set('Authorization', `Bearer ${oh}`).expect(400);
  });
});
