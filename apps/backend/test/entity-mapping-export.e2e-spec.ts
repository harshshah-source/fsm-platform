import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ENTITY_MAPPING_HEADERS } from '../src/exports/entity-mapping-export.service';

/**
 * Issue 120 — the OH raw-data export surface (`/api/exports/entity-mapping`). Covers RBAC (OH-only),
 * the CSV envelope (headers + content-type), and one fully-seeded device row's cell shape. The
 * `plant_fsm_status = 'deactivated'` case lands with #119 Task A (plant deactivation).
 */
describe('/api/exports/entity-mapping (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const NS = Date.now().toString();
  const deviceId = `EXP-${NS}`;
  const vehicleNo = `EXPV-${NS}`;
  const sourcePlantId = BigInt(NS.slice(-9));
  // Second device on a DEACTIVATED plant (Issue 119) — proves plant_fsm_status = 'deactivated'.
  const deactivatedDeviceId = `EXPD-${NS}`;
  const deactivatedSourcePlantId = BigInt(NS.slice(-9)) + 1n;

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const company = await prisma.company.create({
      data: { name: `EXP Co ${NS}`, companyTier: 'GOLD', companyPriorityRank: '1' },
    });
    const transporter = await prisma.transporter.create({ data: { name: `EXP Trans ${NS}` } });
    // zoneId 1 exists from the global seed; a synced source_plant_id + a set zone_id ⇒ zone_source 'mapped'.
    const plant = await prisma.plant.create({
      data: { name: `EXP Plant ${NS}`, zoneId: 1n, sourcePlantId },
    });
    const vehicle = await prisma.vehicle.create({
      data: {
        vehicleNo,
        plantId: plant.plantId,
        companyId: company.companyId,
        transporterId: transporter.transporterId,
        status: 'DEPLOYED',
      },
    });
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        vehicleId: vehicle.vehicleId,
        plantId: plant.plantId,
        companyId: company.companyId,
        transporterId: transporter.transporterId,
        isInactive: true,
        inactivityHours: '26.5',
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        latestGpsDatetime: new Date('2026-07-12T00:00:00.000Z'),
        computedAt: new Date(),
      },
    });

    // A device whose plant carries an active deactivation → exported as plant_fsm_status 'deactivated'.
    const deactivatedPlant = await prisma.plant.create({
      data: { name: `EXP Dead Plant ${NS}`, zoneId: 1n, sourcePlantId: deactivatedSourcePlantId },
    });
    await prisma.device.create({ data: { deviceId: deactivatedDeviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId: deactivatedDeviceId,
        plantId: deactivatedPlant.plantId,
        companyId: company.companyId,
        isInactive: true,
        eligibleForUptime: true,
        computedAt: new Date(),
      },
    });
    await prisma.plantDeactivation.create({
      data: { plantId: deactivatedPlant.plantId, reason: 'export test', deactivatedAt: new Date() },
    });
  });

  afterAll(async () => {
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: [deviceId, deactivatedDeviceId] } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: [deviceId, deactivatedDeviceId] } } });
    await prisma.vehicle.deleteMany({ where: { vehicleNo } });
    await prisma.plantDeactivation.deleteMany({ where: { plant: { sourcePlantId: deactivatedSourcePlantId } } });
    await prisma.plant.deleteMany({ where: { sourcePlantId: { in: [sourcePlantId, deactivatedSourcePlantId] } } });
    await app.close();
  });

  it('lets an Operations Head download the CSV', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/exports/entity-mapping')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment; filename="entity-mapping-');
  });

  it.each([
    ['a CSM', 'csm@fsm.test'],
    ['a ZM', 'zm.north@fsm.test'],
    ['an SE', 'se.north@fsm.test'],
  ])('forbids %s', async (_label, email) => {
    const token = await login(email);
    await request(app.getHttpServer())
      .get('/api/exports/entity-mapping')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('gives the OH a summary hint (row count + data freshness), forbidden to a ZM', async () => {
    const oh = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/exports/entity-mapping/summary')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
    expect(typeof res.body.rowCount).toBe('number');
    expect(res.body.rowCount).toBeGreaterThanOrEqual(1);
    expect(res.body).toHaveProperty('dataAsOf');

    const zm = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/exports/entity-mapping/summary')
      .set('Authorization', `Bearer ${zm}`)
      .expect(403);
  });

  it('emits the canonical header row', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/exports/entity-mapping')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const header = res.text.split('\n', 1)[0];
    expect(header).toBe(ENTITY_MAPPING_HEADERS.join(','));
  });

  it('emits the seeded device as one row with the joined + derived columns', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/exports/entity-mapping')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const line = res.text.split('\n').find((l) => l.startsWith(`${deviceId},`));
    expect(line).toBeDefined();
    const cells = (line as string).split(',');
    const col = (name: (typeof ENTITY_MAPPING_HEADERS)[number]) => cells[ENTITY_MAPPING_HEADERS.indexOf(name)];

    expect(col('vehicle_no')).toBe(vehicleNo);
    expect(col('company')).toBe(`EXP Co ${NS}`);
    expect(col('plant_name')).toBe(`EXP Plant ${NS}`);
    expect(col('source_plant_id')).toBe(String(sourcePlantId));
    expect(col('zone_source')).toBe('mapped');
    expect(col('transporter')).toBe(`EXP Trans ${NS}`);
    expect(col('deployment_status')).toBe('DEPLOYED');
    expect(col('plant_fsm_status')).toBe('active');
    expect(col('sla_bucket')).toBe('CRITICAL');
    expect(col('eligible_for_uptime')).toBe('true');
    expect(col('open_ticket_count')).toBe('0');
  });

  it("marks a deactivated plant's device as plant_fsm_status 'deactivated' (#119)", async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/exports/entity-mapping')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const line = res.text.split('\n').find((l) => l.startsWith(`${deactivatedDeviceId},`));
    expect(line).toBeDefined();
    const cells = (line as string).split(',');
    expect(cells[ENTITY_MAPPING_HEADERS.indexOf('plant_fsm_status')]).toBe('deactivated');
  });
});
