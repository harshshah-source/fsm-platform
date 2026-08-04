import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Zone drill-down reads (`/reports/device?zoneId=…&status=…`):
 *  - `/api/dashboard/company-plant-overview` gains a `zoneId` filter, ADDITIVE to the ZM clamp;
 *  - `/api/dashboard/zone-operations` is new — how a zone's open work is currently held
 *    (assigned / unassigned / live batches / overridden / SEs), scoped by the page's own
 *    `zoneId` + `status`.
 *
 * The fixture builds one zone with two devices at one plant: one INACTIVE device carrying an
 * assigned, batched ticket, and one ACTIVE (recovered) device carrying an unassigned ticket. That
 * pair is what makes the `status` scoping observable — each status returns a different ticket.
 */
const NS = Date.now();
const ZM_ZONE = 1; // zm.north@fsm.test's own zone, per the shared auth fixture

describe('Zone drill-down — company-plant-overview zoneId + zone-operations', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  let seUserId: string;
  let scheduleId: bigint;
  let batchId: bigint;
  let assignedTicketId: string;
  let unassignedTicketId: string;
  let inactiveCycleId: string;
  let activeCycleId: string;
  const inactiveDeviceId = String(19_200_000_000 + (NS % 100_000));
  const activeDeviceId = String(19_300_000_000 + (NS % 100_000));

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const zoneOps = async (token: string, qs: string) => {
    const res = await request(app.getHttpServer())
      .get(`/api/dashboard/zone-operations${qs}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body as {
      openTickets: number;
      assigned: number;
      unassigned: number;
      liveBatches: number;
      overriddenBatches: number;
      engineersEngaged: number;
    };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const tag = randomUUID().slice(0, 8);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-zdd-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({
        data: { name: 'Co-zdd-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' },
      })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'Plant-zdd-' + NS, zoneId } })).plantId;

    for (const id of [inactiveDeviceId, activeDeviceId]) await prisma.device.create({ data: { deviceId: id } });
    // Inactive: silent past the threshold, so SLA-bucketed — the shared inactive predicate.
    await prisma.deviceState.create({
      data: {
        deviceId: inactiveDeviceId, plantId, companyId,
        isInactive: true, slaBucket: 'CRITICAL', inactivityHours: 30, computedAt: new Date(),
      },
    });
    // Active: reporting normally, but its ticket is still open — the case `status=ACTIVE` surfaces.
    await prisma.deviceState.create({
      data: {
        deviceId: activeDeviceId, plantId, companyId,
        isInactive: false, slaBucket: null, inactivityHours: 1, computedAt: new Date(),
      },
    });

    const seUser = await prisma.user.create({
      data: {
        name: 'SE ZDD ' + NS, role: 'SERVICE_ENGINEER',
        phone: 'zddse-' + tag, email: `${tag}-se-${NS}@zdd.test`, zoneId,
      },
    });
    seUserId = seUser.userId;
    seId = seUser.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: seId, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: 8 },
    });

    inactiveCycleId = (
      await prisma.failureCycle.create({ data: { deviceId: inactiveDeviceId, state: 'OPEN', openedAt: new Date() } })
    ).cycleId;
    activeCycleId = (
      await prisma.failureCycle.create({ data: { deviceId: activeDeviceId, state: 'OPEN', openedAt: new Date() } })
    ).cycleId;

    assignedTicketId = (
      await prisma.ticket.create({
        data: {
          workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: inactiveCycleId,
          deviceId: inactiveDeviceId, plantId, companyId, companyTier: 'GOLD',
          assignmentState: 'FORMALLY_ASSIGNED', lastStateChangedAt: new Date(),
        },
      })
    ).ticketId;
    unassignedTicketId = (
      await prisma.ticket.create({
        data: {
          workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: activeCycleId,
          deviceId: activeDeviceId, plantId, companyId, companyTier: 'GOLD',
          assignmentState: 'UNASSIGNED', lastStateChangedAt: new Date(),
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
    await prisma.batchAssignmentTicket.create({ data: { batchId, ticketId: assignedTicketId, sortOrder: 1 } });
  });

  afterAll(async () => {
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId } });
    await prisma.workSchedule.deleteMany({ where: { scheduleId } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: [assignedTicketId, unassignedTicketId] } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: [inactiveCycleId, activeCycleId] } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: [inactiveDeviceId, activeDeviceId] } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: [inactiveDeviceId, activeDeviceId] } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: seId } });
    await prisma.user.deleteMany({ where: { userId: seUserId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  describe('company-plant-overview?zoneId', () => {
    it('narrows an Operations Head to the requested zone only', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await request(app.getHttpServer())
        .get(`/api/dashboard/company-plant-overview?zoneId=${zoneId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const rows = res.body as Array<{ zoneId: string; plantId: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((r) => r.zoneId === zoneId.toString())).toBe(true);
      expect(rows.some((r) => r.plantId === plantId.toString())).toBe(true);
    });

    it('is additive to the ZM clamp — a ZM asking for a foreign zone gets nothing, never another zone', async () => {
      const token = await login('zm.north@fsm.test');
      const res = await request(app.getHttpServer())
        .get(`/api/dashboard/company-plant-overview?zoneId=${zoneId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // The two predicates are ANDed and unsatisfiable together, so the correct answer is empty —
      // NOT the ZM's own zone silently substituted, and not the foreign zone's rows.
      expect(res.body).toEqual([]);
    });

    it('leaves a ZM asking for their OWN zone with their own rows', async () => {
      const token = await login('zm.north@fsm.test');
      const res = await request(app.getHttpServer())
        .get(`/api/dashboard/company-plant-overview?zoneId=${ZM_ZONE}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const rows = res.body as Array<{ zoneId: string }>;
      expect(rows.every((r) => r.zoneId === String(ZM_ZONE))).toBe(true);
    });

    it('ignores a non-numeric zoneId rather than failing the page', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await request(app.getHttpServer())
        .get('/api/dashboard/company-plant-overview?zoneId=UNZONED')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('zone-operations', () => {
    it('splits the zone open work into assigned / unassigned with its batch and SE counts', async () => {
      const token = await login('ops.head@fsm.test');
      const body = await zoneOps(token, `?zoneId=${zoneId}`);

      expect(body.openTickets).toBe(2);
      expect(body.assigned).toBe(1);
      expect(body.unassigned).toBe(1);
      expect(body.liveBatches).toBe(1);
      expect(body.overriddenBatches).toBe(0);
      expect(body.engineersEngaged).toBe(1);
    });

    it('scopes by status — INACTIVE returns the silent device\'s assigned ticket only', async () => {
      const token = await login('ops.head@fsm.test');
      const body = await zoneOps(token, `?zoneId=${zoneId}&status=INACTIVE`);

      expect(body.openTickets).toBe(1);
      expect(body.assigned).toBe(1);
      expect(body.unassigned).toBe(0);
      expect(body.liveBatches).toBe(1);
    });

    it('scopes by status — ACTIVE returns open work on the recovered device only', async () => {
      const token = await login('ops.head@fsm.test');
      const body = await zoneOps(token, `?zoneId=${zoneId}&status=ACTIVE`);

      expect(body.openTickets).toBe(1);
      expect(body.assigned).toBe(0);
      expect(body.unassigned).toBe(1);
      // That ticket is not batched, so no batch and no SE is engaged on it.
      expect(body.liveBatches).toBe(0);
      expect(body.engineersEngaged).toBe(0);
    });

    it('counts an overridden batch as overridden', async () => {
      const token = await login('ops.head@fsm.test');
      await prisma.plantBatchAssignment.update({ where: { batchId }, data: { status: 'OVERRIDDEN' } });
      try {
        const body = await zoneOps(token, `?zoneId=${zoneId}`);
        expect(body.liveBatches).toBe(1);
        expect(body.overriddenBatches).toBe(1);
      } finally {
        await prisma.plantBatchAssignment.update({ where: { batchId }, data: { status: 'AUTO_ASSIGNED' } });
      }
    });

    it('drops a ticket once it closes', async () => {
      const token = await login('ops.head@fsm.test');
      await prisma.ticket.update({ where: { ticketId: unassignedTicketId }, data: { status: 'CLOSED' } });
      try {
        const body = await zoneOps(token, `?zoneId=${zoneId}`);
        expect(body.openTickets).toBe(1);
        expect(body.unassigned).toBe(0);
      } finally {
        await prisma.ticket.update({ where: { ticketId: unassignedTicketId }, data: { status: 'OPEN' } });
      }
    });

    it('clamps a Zonal Manager to their own zone', async () => {
      const token = await login('zm.north@fsm.test');
      // The fixture's work lives in a foreign zone, so a ZM asking for it sees none of it.
      const body = await zoneOps(token, `?zoneId=${zoneId}`);
      expect(body.openTickets).toBe(0);
      expect(body.liveBatches).toBe(0);
    });

    it('forbids a Service Engineer', async () => {
      const token = await login('se.north@fsm.test');
      await request(app.getHttpServer())
        .get('/api/dashboard/zone-operations')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });
});
