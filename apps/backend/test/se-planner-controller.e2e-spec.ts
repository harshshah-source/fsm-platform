import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 14a, slice 2 — the SE Planner HTTP surface (AC#2/#5). Manager-roled CRUD at /api/planner;
 * SEs are gated out. (Zone-scoping behaviour is covered at the service level.)
 *
 * #343 adds the audit half: a planner cell is a dispatch intent the Morning Batch reads as a bias, so
 * "who put this SE at that plant, and who took it away again" has to be answerable after the fact.
 */
const NS = Date.now();

describe('SE Planner /api/planner (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let plantId: bigint;
  let se: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    // Zone 1 (North) is the seeded ZM's own zone, so the write is in scope for zm.north.
    plantId = (await prisma.plant.create({ data: { name: 'P-plc-' + NS, zoneId: 1n } })).plantId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'Planner SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'plc-' + tag, email: `${tag}-${NS}@plc.test`, zoneId: 1n },
    });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId: 1n, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'se_planner', entityId: { startsWith: `${se}:` } } });
    await prisma.sePlanner.deleteMany({ where: { seId: se } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  it('lists planner entries for a ZM', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/planner?dateFrom=2026-06-22&dateTo=2026-06-28')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  /**
   * #343 AC1 — one row per action, and both rows keyed on the **cell** (`se:plant:date`) rather than
   * on the row id, so a create and the delete that undoes it land on the same entity. The row id is a
   * fresh autoincrement each time the same cell is re-planned; keying on it would scatter one cell's
   * history across as many entities as it had lives.
   */
  it('AC1 — creating and deleting a planner entry each write one audit row on the cell', async () => {
    const token = await login('zm.north@fsm.test');
    const plannedDate = '2026-06-23';

    const created = await request(app.getHttpServer())
      .post('/api/planner')
      .set('Authorization', `Bearer ${token}`)
      .send({ seId: se, plantId: String(plantId), plannedDate })
      .expect(201);

    const entityId = `${se}:${plantId}:${plannedDate}`;
    const afterCreate = await prisma.auditLog.findMany({ where: { entityType: 'se_planner', entityId } });
    expect(afterCreate).toHaveLength(1);
    expect(afterCreate[0].action).toBe('PLANNER_ENTRY_SET');
    expect(afterCreate[0].actorRole).toBe('ZONAL_MANAGER');
    expect(afterCreate[0].metadata).toMatchObject({ seId: se, plantId: String(plantId), plannedDate });

    await request(app.getHttpServer())
      .delete(`/api/planner/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'se_planner', entityId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual(['PLANNER_ENTRY_SET', 'PLANNER_ENTRY_REMOVED']);
    expect(rows[1].metadata).toMatchObject({ seId: se, plantId: String(plantId), plannedDate });
  });

  it('forbids an SE from the planner', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/planner?dateFrom=2026-06-22&dateTo=2026-06-28')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/planner?dateFrom=2026-06-22&dateTo=2026-06-28').expect(401);
  });
});
