import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PlantEligibleFloatingSeService } from '../src/org/plant-eligible-floating-se.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 09, slice 5 — the MV refresh path (AC#5). Editing a FLOATING SE's territory through the API
 * refreshes `plant_eligible_floating_se`, so the eligible set reflects the change with no manual
 * refresh. Proven for both add (plant becomes eligible) and remove (plant stops being eligible).
 */
const NS = Date.now();

describe('Issue 09 slice 5 — territory edits refresh the MV', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mv: PlantEligibleFloatingSeService;

  let zoneId: bigint;
  let districtId: bigint;
  let plantId: bigint;
  let seId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    mv = app.get(PlantEligibleFloatingSeService);

    const token = await login('ops.head@fsm.test');
    zoneId = BigInt(await createZone(token));
    districtId = (await prisma.district.create({ data: { name: 'Nagpur ' + NS, state: 'Maharashtra' } })).districtId;
    plantId = (await prisma.plant.create({ data: { name: 'P-ref ' + NS, zoneId, districtId } })).plantId;
    seId = await createFloatingSe(token, Number(zoneId));
  });

  afterAll(async () => {
    await prisma.engineerTerritoryCoverage.deleteMany({ where: { seId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: seId } });
    await prisma.user.deleteMany({ where: { userId: seId } });
    await prisma.district.deleteMany({ where: { districtId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await mv.refresh();
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
  const createFloatingSe = async (token: string, zone: number): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await request(app.getHttpServer())
      .post('/api/org/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `U ${tag}`, role: 'SERVICE_ENGINEER', email: `${tag}@fsm.test`, phone: `+91${tag}`, zoneId: zone })
      .expect(201);
    const userId = u.body.userId as string;
    await request(app.getHttpServer())
      .post('/api/org/engineers')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId, coverageType: 'FLOATING', zoneId: zone, dailyCapacity: 6 })
      .expect(201);
    return userId;
  };

  it('makes a plant eligible after POSTing territory (no manual refresh)', async () => {
    const token = await login('ops.head@fsm.test');
    const created = await request(app.getHttpServer())
      .post('/api/org/se-territory')
      .set('Authorization', `Bearer ${token}`)
      .send({ seId, districtId: Number(districtId) })
      .expect(201);

    expect(await mv.eligibleSeIdsForPlant(plantId)).toContain(seId);
    // Remove it → plant stops being eligible after the delete refreshes.
    await request(app.getHttpServer())
      .delete(`/api/org/se-territory/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(await mv.eligibleSeIdsForPlant(plantId)).not.toContain(seId);
  });
});
