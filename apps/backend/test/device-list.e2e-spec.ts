import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Device list read (`GET /api/devices`) — the FE-22 gap. Manager read, zone-scoped (ZM own-zone,
 * CSM/OH all), searchable; driven from `device_states` joined to vehicle / plant / zone / company.
 */
const NS = Date.now();

describe('Device list (FE-22 backend, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let vehicleId: bigint;
  const deviceId = String(11_900_000_000 + (NS % 100_000));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-dl-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Acme-dl-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'Plant-dl-' + NS, zoneId } })).plantId;
    vehicleId = (await prisma.vehicle.create({ data: { vehicleNo: 'DL-VEH-' + NS, plantId, companyId } })).vehicleId;
    await prisma.device.create({ data: { deviceId, currentVehicleId: vehicleId, deviceType: 'AIS-140' } });
    await prisma.deviceState.create({
      data: {
        deviceId, vehicleId, plantId, companyId,
        isInactive: true, slaBucket: 'CRITICAL', latestGpsDatetime: new Date(NS - 40 * 3600 * 1000), computedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await prisma.deviceState.deleteMany({ where: { deviceId } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.vehicle.deleteMany({ where: { vehicleId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  it('lists the device with vehicle / plant / zone / bucket for a manager (Operations Head)', async () => {
    const token = await login('ops.head@fsm.test');
    // Scope by search so the assertion is deterministic regardless of how many devices the DB holds.
    const res = await request(app.getHttpServer())
      .get(`/api/devices?search=DL-VEH-${NS}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const row = (res.body as { deviceId: string; vehicleNo: string; plantName: string; zoneName: string; slaBucket: string; latestGpsDatetime: string | null }[]).find(
      (r) => r.deviceId === String(deviceId),
    );
    expect(row).toBeDefined();
    expect(row!.vehicleNo).toBe('DL-VEH-' + NS);
    expect(row!.plantName).toBe('Plant-dl-' + NS);
    expect(row!.zoneName).toBe('Z-dl-' + NS);
    expect(row!.slaBucket).toBe('CRITICAL');
    // Issue 3 — the elapsed-inactivity duration source is exposed to the UI.
    expect(row!.latestGpsDatetime).toBe(new Date(NS - 40 * 3600 * 1000).toISOString());
  });

  it('filters by search term', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer()).get(`/api/devices?search=DL-VEH-${NS}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect((res.body as { deviceId: string }[]).some((r) => r.deviceId === String(deviceId))).toBe(true);

    const miss = await request(app.getHttpServer()).get('/api/devices?search=__no-such-thing__').set('Authorization', `Bearer ${token}`).expect(200);
    expect((miss.body as { deviceId: string }[]).some((r) => r.deviceId === String(deviceId))).toBe(false);
  });

  it('excludes a device outside the ZM zone', async () => {
    const token = await login('zm.north@fsm.test'); // dev ZM = zone 1, not the seeded zone
    const res = await request(app.getHttpServer()).get('/api/devices').set('Authorization', `Bearer ${token}`).expect(200);
    expect((res.body as { deviceId: string }[]).some((r) => r.deviceId === String(deviceId))).toBe(false);
  });

  it('forbids a Service Engineer (manager-only read)', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/devices').set('Authorization', `Bearer ${token}`).expect(403);
  });
});
