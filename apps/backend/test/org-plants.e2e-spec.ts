import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 02, Slice 3 — plants as Operations-Head-owned reference data (`/api/org/plants`).
 * Plants roll up to a zone (schema D1); the zone→plant drill-down feeds Issues 06/07.
 * Geo columns (location/lat/lon) and district FK are deferred to Issue 09 (PostGIS).
 */
describe('Issue 02 Slice 3 — /api/org/plants (plant reference CRUD)', () => {
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

  async function createZone(token: string): Promise<number> {
    const res = await request(app.getHttpServer())
      .post('/api/org/zones')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Zone ${randomUUID().slice(0, 8)}` })
      .expect(201);
    return res.body.zoneId as number;
  }

  it('lets Operations Head create a plant under a zone and lists it', async () => {
    const token = await login('ops.head@fsm.test');
    const zoneId = await createZone(token);
    const name = `Plant ${randomUUID().slice(0, 8)}`;

    const created = await request(app.getHttpServer())
      .post('/api/org/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, zoneId })
      .expect(201);
    expect(created.body.plantId).toEqual(expect.any(Number));
    expect(created.body.name).toBe(name);
    expect(created.body.zoneId).toBe(zoneId);

    const list = await request(app.getHttpServer())
      .get(`/api/org/plants?zoneId=${zoneId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.some((p: { name: string }) => p.name === name)).toBe(true);
  });

  it('rejects a plant under a non-existent zone with 404', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Orphan Plant', zoneId: 99999999 })
      .expect(404);
  });

  it('rejects a non-Operations-Head writer with 403', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nope', zoneId: 1 })
      .expect(403);
  });
});
