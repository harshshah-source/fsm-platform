import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 02 Slice 6 — SE profiles + plant coverage (`engineer_master` + `se_coverage`). Operations
 * Head registers an SE's coverage type (DEDICATED / MULTI_PLANT / FLOATING) and maps Dedicated /
 * Multi-Plant SEs to plants (schema D3, AC#2). FLOATING never lands in se_coverage. Consumed by the
 * Recommender precedence (Issue 10) and CoverageScopeGuard (Issue 12).
 */
describe('Issue 02 Slice 6 — SE coverage (engineer_master + se_coverage)', () => {
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

  async function createPlant(token: string, zoneId: number): Promise<number> {
    const res = await request(app.getHttpServer())
      .post('/api/org/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Plant ${randomUUID().slice(0, 8)}`, zoneId })
      .expect(201);
    return res.body.plantId as number;
  }

  async function createUser(token: string, role: string, zoneId?: number): Promise<string> {
    const tag = randomUUID().slice(0, 8);
    const res = await request(app.getHttpServer())
      .post('/api/org/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `U ${tag}`, role, email: `${tag}@fsm.test`, phone: `+91${tag}`, zoneId })
      .expect(201);
    return res.body.userId as string;
  }

  it('registers an SE profile with a coverage type and lists it', async () => {
    const token = await login('ops.head@fsm.test');
    const zoneId = await createZone(token);
    const seId = await createUser(token, 'SERVICE_ENGINEER', zoneId);

    const created = await request(app.getHttpServer())
      .post('/api/org/engineers')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 8 })
      .expect(201);
    expect(created.body.engineerId).toBe(seId);
    expect(created.body.coverageType).toBe('DEDICATED');
    expect(created.body.dailyCapacity).toBe(8);

    const list = await request(app.getHttpServer())
      .get('/api/org/engineers')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.some((e: { engineerId: string }) => e.engineerId === seId)).toBe(true);
  });

  it('rejects an invalid coverage type with 400', async () => {
    const token = await login('ops.head@fsm.test');
    const zoneId = await createZone(token);
    const seId = await createUser(token, 'SERVICE_ENGINEER', zoneId);
    await request(app.getHttpServer())
      .post('/api/org/engineers')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: seId, coverageType: 'WANDERING', zoneId, dailyCapacity: 8 })
      .expect(400);
  });

  it('rejects a non-SE user as an engineer with 400', async () => {
    const token = await login('ops.head@fsm.test');
    const zoneId = await createZone(token);
    const zmId = await createUser(token, 'ZONAL_MANAGER', zoneId);
    await request(app.getHttpServer())
      .post('/api/org/engineers')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: zmId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 8 })
      .expect(400);
  });

  it('maps an SE to a plant and lists the coverage', async () => {
    const token = await login('ops.head@fsm.test');
    const zoneId = await createZone(token);
    const plantId = await createPlant(token, zoneId);
    const seId = await createUser(token, 'SERVICE_ENGINEER', zoneId);
    await request(app.getHttpServer())
      .post('/api/org/engineers')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: seId, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: 6 })
      .expect(201);

    const cov = await request(app.getHttpServer())
      .post('/api/org/se-coverage')
      .set('Authorization', `Bearer ${token}`)
      .send({ seId, plantId, coverageType: 'MULTI_PLANT' })
      .expect(201);
    expect(cov.body.seId).toBe(seId);
    expect(cov.body.plantId).toBe(plantId);

    const list = await request(app.getHttpServer())
      .get(`/api/org/se-coverage?seId=${seId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.some((c: { plantId: number }) => c.plantId === plantId)).toBe(true);
  });

  it('rejects a FLOATING coverage mapping with 400 (territory table instead)', async () => {
    const token = await login('ops.head@fsm.test');
    const zoneId = await createZone(token);
    const plantId = await createPlant(token, zoneId);
    const seId = await createUser(token, 'SERVICE_ENGINEER', zoneId);
    await request(app.getHttpServer())
      .post('/api/org/engineers')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: seId, coverageType: 'FLOATING', zoneId, dailyCapacity: 6 })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/org/se-coverage')
      .set('Authorization', `Bearer ${token}`)
      .send({ seId, plantId, coverageType: 'FLOATING' })
      .expect(400);
  });

  it('rejects a duplicate (se, plant) coverage with 409', async () => {
    const token = await login('ops.head@fsm.test');
    const zoneId = await createZone(token);
    const plantId = await createPlant(token, zoneId);
    const seId = await createUser(token, 'SERVICE_ENGINEER', zoneId);
    await request(app.getHttpServer())
      .post('/api/org/engineers')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: seId, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: 6 })
      .expect(201);
    const body = { seId, plantId, coverageType: 'MULTI_PLANT' };
    await request(app.getHttpServer())
      .post('/api/org/se-coverage')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/org/se-coverage')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(409);
  });

  it('rejects a non-Operations-Head writer with 403', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/engineers')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: randomUUID(), coverageType: 'DEDICATED', zoneId: 1, dailyCapacity: 8 })
      .expect(403);
  });
});
