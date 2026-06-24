import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 09, slice 6a — geography read endpoints feeding the territory hierarchical selector
 * (`/api/org/geo/...`). States → regions → districts cascade, each filterable by its parent, so the
 * admin UI can drive State → Region → District selection.
 */
const NS = Date.now();
const STATE = 'TestState-' + NS;

describe('Issue 09 slice 6a — geography read endpoints', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let regionId: bigint;
  let districtId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    regionId = (await prisma.region.create({ data: { name: 'Reg-' + NS, state: STATE } })).regionId;
    districtId = (await prisma.district.create({ data: { name: 'Dist-' + NS, state: STATE, regionId } })).districtId;
  });

  afterAll(async () => {
    await prisma.district.deleteMany({ where: { districtId } });
    await prisma.region.deleteMany({ where: { regionId } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  it('lists states, regions (by state), and districts (by state/region)', async () => {
    const token = await login('ops.head@fsm.test');
    const auth = { Authorization: `Bearer ${token}` };

    const states = await request(app.getHttpServer()).get('/api/org/geo/states').set(auth).expect(200);
    expect(states.body).toContain(STATE);

    const regions = await request(app.getHttpServer())
      .get(`/api/org/geo/regions?state=${encodeURIComponent(STATE)}`)
      .set(auth)
      .expect(200);
    expect(regions.body.some((r: { regionId: number }) => r.regionId === Number(regionId))).toBe(true);

    const byState = await request(app.getHttpServer())
      .get(`/api/org/geo/districts?state=${encodeURIComponent(STATE)}`)
      .set(auth)
      .expect(200);
    expect(byState.body.some((d: { districtId: number }) => d.districtId === Number(districtId))).toBe(true);

    const byRegion = await request(app.getHttpServer())
      .get(`/api/org/geo/districts?regionId=${regionId}`)
      .set(auth)
      .expect(200);
    expect(byRegion.body.some((d: { districtId: number }) => d.districtId === Number(districtId))).toBe(true);
  });

  it('requires authentication (401 without a token)', async () => {
    await request(app.getHttpServer()).get('/api/org/geo/states').expect(401);
    void randomUUID;
  });
});
