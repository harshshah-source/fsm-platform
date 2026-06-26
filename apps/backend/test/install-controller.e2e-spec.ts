import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 33, slice 3 — Install Ticket HTTP surface (`/api/install`). Single-create + CSV upload by the
 * creator roles (ZM own zone / CSM / Operations Head). A Service Engineer is forbidden; a ZM creating
 * outside its own zone is rejected; an Operations Head acting in a ZM's zone has `acted_as_role`
 * audited (#47). Seeded `zm.north@fsm.test` is ZM of zone 1.
 */
const DEV_A = 9_362_001n;
const DEV_B = 9_362_002n;
const DEV_C = 9_362_003n;
const ALL_DEV = [DEV_A, DEV_B, DEV_C];

describe('Issue 33 slice 3 — /api/install (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zone1: bigint; // ZM north's zone (seeded as 1)
  let zone2: bigint; // a different zone
  let companyId: bigint;
  let plant1: bigint;
  let plant2: bigint;
  let vehA: string;
  let vehB: string;
  let vehC: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const stamp = Date.now();
    // zm.north has zone_id = 1; ensure a zone row with id 1 exists, else create + use its id is not 1.
    // We instead create plants in a zone whose id matches the ZM's claim by upserting zone 1.
    zone1 = (await prisma.zone.upsert({ where: { zoneId: 1n }, update: {}, create: { zoneId: 1n, name: 'Zone-1-seed' } })).zoneId;
    zone2 = (await prisma.zone.create({ data: { name: 'Z-inst-ctrl-' + stamp } })).zoneId;
    companyId = (
      await prisma.company.create({
        data: { name: 'Co-inst-ctrl-' + stamp, companyTier: 'PLATINUM', companyPriorityRank: 'A' },
      })
    ).companyId;
    plant1 = (await prisma.plant.create({ data: { name: 'P-ctrl-1', zoneId: zone1 } })).plantId;
    plant2 = (await prisma.plant.create({ data: { name: 'P-ctrl-2', zoneId: zone2 } })).plantId;
    vehA = 'CTRL-A-' + stamp;
    vehB = 'CTRL-B-' + stamp;
    vehC = 'CTRL-C-' + stamp;
    await prisma.vehicle.create({ data: { vehicleNo: vehA, plantId: plant1, companyId } });
    await prisma.vehicle.create({ data: { vehicleNo: vehB, plantId: plant2, companyId } });
    await prisma.vehicle.create({ data: { vehicleNo: vehC, plantId: plant1, companyId } });
    await prisma.device.create({ data: { deviceId: DEV_A, deviceType: 'GPS-X' } });
    await prisma.device.create({ data: { deviceId: DEV_B, deviceType: 'GPS-X' } });
    await prisma.device.create({ data: { deviceId: DEV_C, deviceType: 'GPS-X' } });
  });

  afterAll(async () => {
    // Scope cleanup to THIS spec's company so parallel specs can't delete each other's audit rows.
    const ids = (await prisma.ticket.findMany({ where: { workType: 'INSTALL', companyId }, select: { ticketId: true } })).map((t) => t.ticketId);
    if (ids.length > 0) {
      await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ids } } });
      await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ids } } });
      await prisma.ticket.deleteMany({ where: { ticketId: { in: ids } } });
    }
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL_DEV } } });
    await prisma.vehicle.deleteMany({ where: { vehicleNo: { in: [vehA, vehB, vehC] } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plant1, plant2] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: zone2 } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  it('ZM creates a single Install Ticket in its own zone', async () => {
    const zm = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/install')
      .set('Authorization', `Bearer ${zm}`)
      .send({
        vehicleNo: vehA,
        plantId: String(plant1),
        companyId: String(companyId),
        deviceType: 'GPS-X',
        deviceId: String(DEV_A),
        simId: 'SIM-A',
      })
      .expect(201);
    expect(res.body.workType).toBe('INSTALL');
    expect(res.body.status).toBe('REQUESTED');
    expect(res.body.installTriggerSource).toBe('MANUAL_OPERATIONS');
    expect(res.body.createdByRole).toBe('ZONAL_MANAGER');
    expect(res.body.deviceId).toBe(String(DEV_A));
  });

  it('forbids a Service Engineer (403) and rejects a ZM creating outside its zone (403 ZONE_FORBIDDEN)', async () => {
    const se = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/install')
      .set('Authorization', `Bearer ${se}`)
      .send({ vehicleNo: vehC, plantId: String(plant1), companyId: String(companyId), deviceType: 'GPS-X', deviceId: String(DEV_C) })
      .expect(403);

    const zm = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/install')
      .set('Authorization', `Bearer ${zm}`)
      .send({ vehicleNo: vehB, plantId: String(plant2), companyId: String(companyId), deviceType: 'GPS-X', deviceId: String(DEV_B) })
      .expect(403);
    expect(res.body.code).toBe('ZONE_FORBIDDEN');
  });

  it('CSV upload: Operations Head acting in zone 1 creates a batch with acted_as_role audited', async () => {
    const oh = await login('ops.head@fsm.test');
    const header = 'vehicle_no,plant_id,company_id,device_type,device_id,sim_id,target_date,notes';
    const csv = [header, `${vehC},${plant1},${companyId},GPS-X,${DEV_C},SIM-C,,bulk`].join('\n');

    const res = await request(app.getHttpServer())
      .post('/api/install/upload')
      .set('Authorization', `Bearer ${oh}`)
      .set('X-Acting-As-Zone', '1')
      .send({ csv })
      .expect(201);
    expect(res.body.created).toHaveLength(1);

    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'tickets', entityId: res.body.created[0], action: 'INSTALL_TICKET_CREATED' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].actedAsRole).toBe('OPERATIONS_HEAD');
    expect(audits[0].actingZone).toBe(1n);
  });

  it('CSV upload with a bad row returns 400 with line-number errors and creates nothing', async () => {
    const oh = await login('ops.head@fsm.test');
    const header = 'vehicle_no,plant_id,company_id,device_type,device_id';
    const csv = [header, `NOPE,${plant1},${companyId},GPS-X,${DEV_A}`].join('\n');
    const res = await request(app.getHttpServer())
      .post('/api/install/upload')
      .set('Authorization', `Bearer ${oh}`)
      .send({ csv })
      .expect(400);
    expect(res.body.code).toBe('CSV_VALIDATION_FAILED');
    expect(res.body.errors[0]).toEqual({ line: 2, code: 'VEHICLE_NOT_FOUND' });
  });
});
