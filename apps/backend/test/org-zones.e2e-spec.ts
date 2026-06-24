import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 02, Slice 2 — zones as Operations-Head-owned reference data (`/api/org/zones`).
 * Zones are the unit of ZM authority and row-level scoping (schema D1), consumed downstream
 * by the Zone Dashboard (Issue 06) and ticket scoping (Issue 07).
 */
describe('Issue 02 Slice 2 — /api/org/zones (zone reference CRUD)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  it('lets Operations Head create a zone and lists it back', async () => {
    const token = await login('ops.head@fsm.test');
    const name = `Zone ${randomUUID().slice(0, 8)}`;

    const created = await request(app.getHttpServer())
      .post('/api/org/zones')
      .set('Authorization', `Bearer ${token}`)
      .send({ name })
      .expect(201);
    expect(created.body.zoneId).toEqual(expect.any(Number));
    expect(created.body.name).toBe(name);

    const list = await request(app.getHttpServer())
      .get('/api/org/zones')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.some((z: { name: string }) => z.name === name)).toBe(true);
  });

  it('writes an audit_logs row for the zone creation', async () => {
    const token = await login('ops.head@fsm.test');
    const name = `Zone ${randomUUID().slice(0, 8)}`;

    await request(app.getHttpServer())
      .post('/api/org/zones')
      .set('Authorization', `Bearer ${token}`)
      .send({ name })
      .expect(201);

    const prisma = new PrismaService();
    await prisma.onModuleInit();
    try {
      const rows = await prisma.auditLog.findMany({
        where: { entityType: 'zones', entityId: name, action: 'ZONE_CREATED' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].actorRole).toBe('OPERATIONS_HEAD');
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  it('rejects a non-Operations-Head writer with 403', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/zones')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Should Not Persist' })
      .expect(403);
  });

  it('rejects a duplicate zone name with 409', async () => {
    const token = await login('ops.head@fsm.test');
    const name = `Zone ${randomUUID().slice(0, 8)}`;

    await request(app.getHttpServer())
      .post('/api/org/zones')
      .set('Authorization', `Bearer ${token}`)
      .send({ name })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/org/zones')
      .set('Authorization', `Bearer ${token}`)
      .send({ name })
      .expect(409);
  });
});
