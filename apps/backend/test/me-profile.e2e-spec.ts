import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #161 — `/api/me` SE profile enrichment. `SessionView.profile` (`@fsm/shared`) is populated only for
 * `role === 'SERVICE_ENGINEER'`, scoped to exactly what `docs/ui/mobile/home-dashboard.png` (header)
 * and `docs/ui/mobile/profile.png` render — see the shared-package doc comment on `SeProfileView` for
 * the fields considered and deliberately excluded (coverageType/dailyCapacity/shift-window/full
 * covered-plants list do not appear on either screen).
 */
const NS = Date.now();

describe('#161 — GET /api/me SE profile enrichment (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  let zoneId: bigint; // has a ZM assigned
  let zoneNoZmId: bigint; // no ZM assigned
  let companyId: bigint;
  let plantId: bigint;
  let zmUserId: string;
  let seDedicated: string;
  let seMulti: string;
  let seNoZm: string;
  let seNoEngineer: string;
  const userIds: string[] = [];

  const tokenFor = (seId: string, zone: bigint) =>
    tokens.signAccessToken({ user_id: seId, role: 'SERVICE_ENGINEER', zone_id: Number(zone) });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    companyId = (await prisma.company.create({ data: { name: 'Co-mep-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;

    const zmTag = randomUUID().slice(0, 8);
    const zmUser = await prisma.user.create({
      data: { name: 'ZM Profile ' + zmTag, role: 'ZONAL_MANAGER', phone: 'mep-zm-' + zmTag, email: `${zmTag}@mep.test` },
    });
    zmUserId = zmUser.userId;
    userIds.push(zmUserId);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-mep-' + NS, zonalManagerUserId: zmUserId } })).zoneId;
    zoneNoZmId = (await prisma.zone.create({ data: { name: 'Z-mep-nozm-' + NS } })).zoneId;
    plantId = (await prisma.plant.create({ data: { name: 'P-mep-' + NS, zoneId } })).plantId;
    const plantId2 = (await prisma.plant.create({ data: { name: 'P-mep-2-' + NS, zoneId } })).plantId;

    const dedTag = randomUUID().slice(0, 8);
    const dedUser = await prisma.user.create({
      data: { name: 'SE Dedicated ' + dedTag, role: 'SERVICE_ENGINEER', phone: 'mep-ded-' + dedTag, email: `${dedTag}@mep.test`, zoneId },
    });
    seDedicated = dedUser.userId;
    userIds.push(seDedicated);
    await prisma.engineerMaster.create({ data: { engineerId: seDedicated, coverageType: 'DEDICATED', zoneId, dailyCapacity: 8 } });
    await prisma.seCoverage.create({ data: { seId: seDedicated, plantId, coverageType: 'DEDICATED' } });

    const multiTag = randomUUID().slice(0, 8);
    const multiUser = await prisma.user.create({
      data: { name: 'SE Multi ' + multiTag, role: 'SERVICE_ENGINEER', phone: 'mep-multi-' + multiTag, email: `${multiTag}@mep.test`, zoneId },
    });
    seMulti = multiUser.userId;
    userIds.push(seMulti);
    await prisma.engineerMaster.create({ data: { engineerId: seMulti, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: seMulti, plantId, coverageType: 'MULTI_PLANT' } });
    await prisma.seCoverage.create({ data: { seId: seMulti, plantId: plantId2, coverageType: 'MULTI_PLANT' } });

    const nozmTag = randomUUID().slice(0, 8);
    const nozmUser = await prisma.user.create({
      data: { name: 'SE NoZM ' + nozmTag, role: 'SERVICE_ENGINEER', phone: 'mep-nozm-' + nozmTag, email: `${nozmTag}@mep.test`, zoneId: zoneNoZmId },
    });
    seNoZm = nozmUser.userId;
    userIds.push(seNoZm);
    await prisma.engineerMaster.create({ data: { engineerId: seNoZm, coverageType: 'DEDICATED', zoneId: zoneNoZmId, dailyCapacity: 8 } });

    const noEngTag = randomUUID().slice(0, 8);
    const noEngUser = await prisma.user.create({
      data: { name: 'SE NoEngineer ' + noEngTag, role: 'SERVICE_ENGINEER', phone: 'mep-noeng-' + noEngTag, email: `${noEngTag}@mep.test`, zoneId },
    });
    seNoEngineer = noEngUser.userId;
    userIds.push(seNoEngineer);
  });

  afterAll(async () => {
    await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { zoneId: { in: [zoneId] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneId, zoneNoZmId] } } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  it('returns the full profile for a DEDICATED SE with an assigned ZM', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${tokenFor(seDedicated, zoneId)}`)
      .expect(200);

    expect(res.body.profile).toMatchObject({
      name: 'SE Dedicated ' + res.body.profile.name.split(' ').pop(),
      zoneName: 'Z-mep-' + NS,
      coverageType: 'DEDICATED',
      homePlant: { plantId: String(plantId), name: 'P-mep-' + NS },
      reportsTo: { role: 'ZONAL_MANAGER' },
    });
    expect(res.body.profile.phone).toMatch(/^mep-ded-/);
    expect(res.body.profile.reportsTo.name).toMatch(/^ZM Profile /);
    expect(typeof res.body.profile.reportsTo.phone).toBe('string');
    expect(typeof res.body.profile.reportsTo.email).toBe('string');
  });

  it('homePlant is null for a MULTI_PLANT SE — no single "home" plant in the data model', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${tokenFor(seMulti, zoneId)}`)
      .expect(200);

    expect(res.body.profile.coverageType).toBe('MULTI_PLANT');
    expect(res.body.profile.homePlant).toBeNull();
    expect(res.body.profile.reportsTo).not.toBeNull();
  });

  it('reportsTo is null when the SE\'s zone has no Zonal Manager assigned', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${tokenFor(seNoZm, zoneNoZmId)}`)
      .expect(200);

    expect(res.body.profile.reportsTo).toBeNull();
    expect(res.body.profile.homePlant).toBeNull(); // no coverage row created for this fixture SE
  });

  it('omits the profile key entirely for a non-SE role', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer()).get('/api/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body).not.toHaveProperty('profile');
  });

  it('omits the profile key for an SE with no EngineerMaster row, rather than erroring', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${tokenFor(seNoEngineer, zoneId)}`)
      .expect(200);
    expect(res.body).not.toHaveProperty('profile');
    expect(res.body.user_id).toBe(seNoEngineer);
  });
});
