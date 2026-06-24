import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 09, slice 3 — Floating-SE Territory config API (`/api/org/se-territory`, ADR-0006). Operations
 * Head sets a FLOATING SE's territory hierarchically (State / Region / District); each POST adds one
 * union-membership row in `engineer_territory_coverage`. DEDICATED/MULTI_PLANT SEs use `se_coverage`
 * instead (→ 400). A row must define at least one dimension (→ 400). Polygon drawing is deferred —
 * v1 exposes only the hierarchical dimensions.
 */
describe('Issue 09 slice 3 — SE territory config API', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };
  const createZone = async (token: string): Promise<number> => {
    const res = await request(app.getHttpServer())
      .post('/api/org/zones')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Zone ${randomUUID().slice(0, 8)}` })
      .expect(201);
    return res.body.zoneId as number;
  };
  const createUser = async (token: string, role: string, zoneId?: number): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const res = await request(app.getHttpServer())
      .post('/api/org/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `U ${tag}`, role, email: `${tag}@fsm.test`, phone: `+91${tag}`, zoneId })
      .expect(201);
    return res.body.userId as string;
  };
  const createFloatingSe = async (token: string, zoneId: number): Promise<string> => {
    const seId = await createUser(token, 'SERVICE_ENGINEER', zoneId);
    await request(app.getHttpServer())
      .post('/api/org/engineers')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: seId, coverageType: 'FLOATING', zoneId, dailyCapacity: 6 })
      .expect(201);
    return seId;
  };

  it('sets a Floating SE territory by state and lists it (union membership)', async () => {
    const token = await login('ops.head@fsm.test');
    const zoneId = await createZone(token);
    const seId = await createFloatingSe(token, zoneId);

    const created = await request(app.getHttpServer())
      .post('/api/org/se-territory')
      .set('Authorization', `Bearer ${token}`)
      .send({ seId, state: 'Maharashtra' })
      .expect(201);
    expect(created.body.seId).toBe(seId);
    expect(created.body.state).toBe('Maharashtra');

    const list = await request(app.getHttpServer())
      .get(`/api/org/se-territory?seId=${seId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.some((t: { state: string }) => t.state === 'Maharashtra')).toBe(true);
  });

  it('sets territory by district FK', async () => {
    const token = await login('ops.head@fsm.test');
    const zoneId = await createZone(token);
    const seId = await createFloatingSe(token, zoneId);
    const district = await prisma.district.create({
      data: { name: 'Pune ' + randomUUID().slice(0, 6), state: 'Maharashtra' },
    });

    const created = await request(app.getHttpServer())
      .post('/api/org/se-territory')
      .set('Authorization', `Bearer ${token}`)
      .send({ seId, districtId: Number(district.districtId) })
      .expect(201);
    expect(created.body.districtId).toBe(Number(district.districtId));
  });

  it('rejects territory with no dimension (400)', async () => {
    const token = await login('ops.head@fsm.test');
    const zoneId = await createZone(token);
    const seId = await createFloatingSe(token, zoneId);
    await request(app.getHttpServer())
      .post('/api/org/se-territory')
      .set('Authorization', `Bearer ${token}`)
      .send({ seId })
      .expect(400);
  });

  it('rejects a non-FLOATING SE (400 — use se_coverage)', async () => {
    const token = await login('ops.head@fsm.test');
    const zoneId = await createZone(token);
    const seId = await createUser(token, 'SERVICE_ENGINEER', zoneId);
    await request(app.getHttpServer())
      .post('/api/org/engineers')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 8 })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/org/se-territory')
      .set('Authorization', `Bearer ${token}`)
      .send({ seId, state: 'Maharashtra' })
      .expect(400);
  });

  it('rejects an unknown district (404)', async () => {
    const token = await login('ops.head@fsm.test');
    const zoneId = await createZone(token);
    const seId = await createFloatingSe(token, zoneId);
    await request(app.getHttpServer())
      .post('/api/org/se-territory')
      .set('Authorization', `Bearer ${token}`)
      .send({ seId, districtId: 999_000_111 })
      .expect(404);
  });

  it('requires OPERATIONS_HEAD (SE token → 403)', async () => {
    const opsToken = await login('ops.head@fsm.test');
    const zoneId = await createZone(opsToken);
    const seId = await createFloatingSe(opsToken, zoneId);
    // A plain SE account cannot configure territory.
    const seToken = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/se-territory')
      .set('Authorization', `Bearer ${seToken}`)
      .send({ seId, state: 'Maharashtra' })
      .expect(403);
  });
});
