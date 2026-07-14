import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 122 — enriched dashboard/ticket/device/engineer reads for the UI work order:
 *  - `/api/tickets` rows carry plant/company display names, the vehicle number, the assigned SE and
 *    the overridden flag, and support the `plant` (name-or-id) and `q` (universal) filters;
 *  - `/api/dashboard/zone-overview` rows carry `zonalManagerName`;
 *  - `/api/devices` rows carry the open-ticket assignment context and support `criticalPlus=true`;
 *  - `/api/engineers/:seId` detail carries the schedule header + plant stops with ticket context.
 */
const NS = Date.now();

describe('Issue 122 — enriched reads', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zoneId: bigint;
  let zmUserId: string;
  let companyId: bigint;
  let plantId: bigint;
  let vehicleId: bigint;
  let seId: string;
  let scheduleId: bigint;
  let batchId: bigint;
  let ticketId: string;
  let cycleId: string;
  const deviceId = String(12_200_000_000 + (NS % 100_000));
  const vehicleNo = 'I122-VEH-' + NS;

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

    const tag = randomUUID().slice(0, 8);
    const zm = await prisma.user.create({
      data: { name: 'ZM I122 ' + NS, role: 'ZONAL_MANAGER', phone: 'i122zm-' + tag, email: `${tag}-zm-${NS}@i122.test` },
    });
    zmUserId = zm.userId;
    zoneId = (await prisma.zone.create({ data: { name: 'Z-i122-' + NS, zonalManagerUserId: zmUserId } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-i122-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'Plant-i122-' + NS, zoneId } })).plantId;
    vehicleId = (await prisma.vehicle.create({ data: { vehicleNo, plantId, companyId } })).vehicleId;
    await prisma.device.create({ data: { deviceId, currentVehicleId: vehicleId } });
    await prisma.deviceState.create({
      data: {
        deviceId, vehicleId, plantId, companyId,
        isInactive: true, slaBucket: 'CRITICAL', inactivityHours: 30,
        latestGpsDatetime: new Date(NS - 30 * 3600 * 1000), computedAt: new Date(),
      },
    });

    const seUser = await prisma.user.create({
      data: { name: 'SE I122 ' + NS, role: 'SERVICE_ENGINEER', phone: 'i122se-' + tag, email: `${tag}-se-${NS}@i122.test`, zoneId },
    });
    seId = seUser.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: seId, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: 8 },
    });

    cycleId = (await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: new Date() } })).cycleId;
    ticketId = (
      await prisma.ticket.create({
        data: {
          workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycleId,
          deviceId, vehicleId, plantId, companyId, companyTier: 'GOLD',
          assignmentState: 'FORMALLY_ASSIGNED', lastStateChangedAt: new Date(),
        },
      })
    ).ticketId;

    const today = new Date();
    scheduleId = (
      await prisma.workSchedule.create({
        data: { seId, zoneId, dateFrom: today, dateTo: today, status: 'ACTIVE', dispatchedAt: new Date() },
      })
    ).scheduleId;
    batchId = (
      await prisma.plantBatchAssignment.create({
        data: { scheduleId, plantId, seId, status: 'AUTO_ASSIGNED', stopSequence: 1 },
      })
    ).batchId;
    await prisma.batchAssignmentTicket.create({ data: { batchId, ticketId, sortOrder: 1 } });
  });

  afterAll(async () => {
    await prisma.batchAssignmentTicket.deleteMany({ where: { ticketId } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId } });
    await prisma.workSchedule.deleteMany({ where: { scheduleId } });
    await prisma.ticket.deleteMany({ where: { ticketId } });
    await prisma.failureCycle.deleteMany({ where: { cycleId } });
    await prisma.deviceState.deleteMany({ where: { deviceId } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.vehicle.deleteMany({ where: { vehicleId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: seId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.user.deleteMany({ where: { userId: { in: [zmUserId, seId] } } });
    await app.close();
  });

  it('ticket rows carry display names, vehicle number, and the live assignment', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/tickets?q=${vehicleNo}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    const t = res.body[0];
    expect(t.ticketId).toBe(ticketId);
    expect(t.plantName).toBe('Plant-i122-' + NS);
    expect(t.companyName).toBe('Co-i122-' + NS);
    expect(t.vehicleNo).toBe(vehicleNo);
    expect(t.assignmentState).toBe('FORMALLY_ASSIGNED');
    expect(t.assignedSeId).toBe(seId);
    expect(t.assignedSeName).toBe('SE I122 ' + NS);
    expect(t.batchId).toBe(String(batchId));
    expect(t.scheduleId).toBe(String(scheduleId));
    expect(t.overridden).toBe(false);
  });

  it('filters tickets by plant name text and by universal q (device id)', async () => {
    const token = await login('ops.head@fsm.test');
    const byPlant = await request(app.getHttpServer())
      .get(`/api/tickets?plant=Plant-i122-${NS}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(byPlant.body.map((t: { ticketId: string }) => t.ticketId)).toEqual([ticketId]);

    const byDevice = await request(app.getHttpServer())
      .get(`/api/tickets?q=${deviceId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(byDevice.body.map((t: { ticketId: string }) => t.ticketId)).toEqual([ticketId]);

    const miss = await request(app.getHttpServer())
      .get('/api/tickets?plant=__no-such-plant__')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(miss.body).toHaveLength(0);
  });

  it('marks the ticket overridden when its batch is OVERRIDDEN', async () => {
    await prisma.plantBatchAssignment.update({ where: { batchId }, data: { status: 'OVERRIDDEN' } });
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/tickets?q=${vehicleNo}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body[0].overridden).toBe(true);
    await prisma.plantBatchAssignment.update({ where: { batchId }, data: { status: 'AUTO_ASSIGNED' } });
  });

  it('zone-overview rows carry the Zonal Manager name', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/zone-overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const row = res.body.find((z: { zoneId: string }) => z.zoneId === String(zoneId));
    expect(row).toBeDefined();
    expect(row.zonalManagerName).toBe('ZM I122 ' + NS);
  });

  it('device rows carry the open-ticket assignment context and honour criticalPlus', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/devices?search=${vehicleNo}&criticalPlus=true`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const row = res.body.rows.find((r: { deviceId: string }) => r.deviceId === deviceId);
    expect(row).toBeDefined();
    expect(row.openTicketId).toBe(ticketId);
    expect(row.assignmentState).toBe('FORMALLY_ASSIGNED');
    expect(row.assignedSeName).toBe('SE I122 ' + NS);
    expect(row.batchId).toBe(String(batchId));
    expect(row.scheduleId).toBe(String(scheduleId));

    // criticalPlus excludes sub-critical buckets: drop the device to WARNING and re-query.
    await prisma.deviceState.update({ where: { deviceId }, data: { slaBucket: 'WARNING' } });
    const excluded = await request(app.getHttpServer())
      .get(`/api/devices?search=${vehicleNo}&criticalPlus=true`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(excluded.body.rows.some((r: { deviceId: string }) => r.deviceId === deviceId)).toBe(false);
    await prisma.deviceState.update({ where: { deviceId }, data: { slaBucket: 'CRITICAL' } });
  });

  it('SE detail carries the schedule header + plant stops with ticket context', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/engineers/${seId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.zoneName).toBe('Z-i122-' + NS);
    expect(res.body.schedule).toMatchObject({ scheduleId: String(scheduleId), status: 'ACTIVE' });
    expect(res.body.stops).toHaveLength(1);
    const stop = res.body.stops[0];
    expect(stop).toMatchObject({
      batchId: String(batchId),
      stopSequence: 1,
      plantId: String(plantId),
      plantName: 'Plant-i122-' + NS,
    });
    expect(stop.tickets).toHaveLength(1);
    expect(stop.tickets[0]).toMatchObject({
      ticketId,
      deviceId,
      vehicleNo,
      workType: 'TROUBLESHOOT',
      status: 'OPEN',
      slaBucket: 'CRITICAL',
      companyName: 'Co-i122-' + NS,
    });
  });
});
