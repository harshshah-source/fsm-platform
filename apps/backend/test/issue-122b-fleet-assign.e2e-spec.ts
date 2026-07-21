import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 122b — the second operator QA batch:
 *  - `/api/dashboard/fleet-summary` returns scoped company/plant/device counts;
 *  - `/api/devices/filter-options` carries company-linked plants; `/api/devices?plantId=` filters;
 *  - `POST /api/schedules/assign-plants` assigns every OPEN+UNASSIGNED ticket at the selected plants
 *    to the SE through the canonical assignTicket flow (schedule + batch + FORMALLY_ASSIGNED).
 */
const NS = Date.now();

describe('Issue 122b — fleet summary + plant filter + multi-plant assign', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let seId: string;
  const deviceA = String(12_300_000_000 + (NS % 100_000));
  const deviceB = String(12_310_000_000 + (NS % 100_000));
  const ticketIds: string[] = [];
  const cycleIds: string[] = [];

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const seedOpenTicket = async (deviceId: string, plantId: bigint) => {
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: new Date() } });
    cycleIds.push(cycle.cycleId);
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId,
        deviceId, plantId, companyId, companyTier: 'GOLD',
        assignmentState: 'UNASSIGNED', lastStateChangedAt: new Date(),
      },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-i122b-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-i122b-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'PlantA-i122b-' + NS, zoneId } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'PlantB-i122b-' + NS, zoneId } })).plantId;

    for (const [deviceId, plantId] of [
      [deviceA, plantA],
      [deviceB, plantB],
    ] as const) {
      await prisma.device.create({ data: { deviceId } });
      await prisma.deviceState.create({
        data: {
          deviceId, plantId, companyId,
          isInactive: true, slaBucket: 'CRITICAL', inactivityHours: 30, computedAt: new Date(),
        },
      });
      await seedOpenTicket(deviceId, plantId);
    }

    const tag = randomUUID().slice(0, 8);
    const seUser = await prisma.user.create({
      data: { name: 'SE I122b ' + NS, role: 'SERVICE_ENGINEER', phone: 'i122b-' + tag, email: `${tag}-${NS}@i122b.test`, zoneId },
    });
    seId = seUser.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: seId, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: 8 },
    });
  });

  afterAll(async () => {
    await prisma.batchAssignmentTicket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { seId } });
    await prisma.workSchedule.deleteMany({ where: { seId } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: [deviceA, deviceB] } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: [deviceA, deviceB] } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: seId } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.user.deleteMany({ where: { userId: seId } });
    await app.close();
  });

  it('fleet-summary returns company/plant/device counts covering the seeded fleet', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/fleet-summary')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    // Absolute values depend on the shared dev DB — assert shape + that our seed is included.
    expect(res.body.companies).toBeGreaterThanOrEqual(1);
    expect(res.body.plants).toBeGreaterThanOrEqual(2);
    expect(res.body.devices).toBeGreaterThanOrEqual(2); // Active Fleet — departed devices excluded.
    // Total Devices (raw AutoPlant catalog) — null until a master sync records `entity_stats.devices.observed`.
    expect(res.body).toHaveProperty('sourceDevices');
    expect(res.body.sourceDevices === null || typeof res.body.sourceDevices === 'number').toBe(true);
  });

  it('fleet-directory lists the seeded company and plants by name with device counts', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/fleet-directory')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const co = res.body.companies.find((c: { companyId: string }) => c.companyId === String(companyId));
    expect(co).toMatchObject({ name: 'Co-i122b-' + NS, tier: 'GOLD', plantCount: 2, deviceCount: 2 });
    const plant = res.body.plants.find((p: { plantId: string }) => p.plantId === String(plantA));
    expect(plant).toMatchObject({
      name: 'PlantA-i122b-' + NS,
      companyName: 'Co-i122b-' + NS,
      zoneName: 'Z-i122b-' + NS,
      deviceCount: 1,
    });
  });

  it('filter-options lists plants with their company link; plantId filters the device list', async () => {
    const token = await login('ops.head@fsm.test');
    const opts = await request(app.getHttpServer())
      .get('/api/devices/filter-options')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const plantOpt = opts.body.plants.find((p: { plantId: number }) => p.plantId === Number(plantA));
    expect(plantOpt).toMatchObject({ name: 'PlantA-i122b-' + NS, companyId: Number(companyId) });

    const list = await request(app.getHttpServer())
      .get(`/api/devices?plantId=${plantA}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.rows.some((r: { deviceId: string }) => r.deviceId === deviceA)).toBe(true);
    expect(list.body.rows.some((r: { deviceId: string }) => r.deviceId === deviceB)).toBe(false);
  });

  it('assign-plants formally assigns every open unassigned ticket at the selected plants', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/schedules/assign-plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ seId, plantIds: [String(plantA), String(plantB)] })
      .expect(200);
    expect(res.body.assigned).toBe(2);
    expect(res.body.perPlant).toHaveLength(2);

    // The canonical flow ran: tickets flipped FORMALLY_ASSIGNED inside a live batch on the SE's schedule.
    const tickets = await prisma.ticket.findMany({ where: { ticketId: { in: ticketIds } } });
    expect(tickets.every((t) => t.assignmentState === 'FORMALLY_ASSIGNED')).toBe(true);
    const batches = await prisma.plantBatchAssignment.findMany({ where: { seId } });
    expect(batches.map((b) => b.plantId).sort()).toEqual([plantA, plantB].sort());

    // Idempotent-ish: a second call finds nothing left to assign.
    const again = await request(app.getHttpServer())
      .post('/api/schedules/assign-plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ seId, plantIds: [String(plantA), String(plantB)] })
      .expect(200);
    expect(again.body.assigned).toBe(0);
  });

  it('rejects a missing SE / empty plant list', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/schedules/assign-plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ seId, plantIds: [] })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/schedules/assign-plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ seId: randomUUID(), plantIds: [String(plantA)] })
      .expect(404);
  });
});
