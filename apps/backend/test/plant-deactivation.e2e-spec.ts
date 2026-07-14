import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TicketCreationService } from '../src/ticketing/ticket-creation.service';
import { DashboardService } from '../src/dashboard/dashboard.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * Issue 119 — FSM-owned plant deactivation. Deactivating a plant cancels its open tickets
 * (reason PLANT_DEACTIVATED, audited) and drops its devices from ticket-creation, dashboard counts
 * and dispatch; it survives a master-sync; reactivation lets the pipeline re-create tickets for
 * still-inactive devices. RBAC: OH only.
 */
describe('Plant deactivation (Issue 119, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ticketCreation: TicketCreationService;
  let dashboard: DashboardService;
  let recommender: RecommenderService;

  const NS = Date.now();
  // Seed timestamps in the real past so cancellation's closed_at (real now) satisfies the
  // failure_cycles closed_at >= opened_at CHECK regardless of the runner's timezone.
  const NOW = new Date(Date.now() - 4 * 86_400_000);
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let deviceId: string;

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const seedInactiveDeviceWithOpenTicket = async (plant: bigint, suffix: string): Promise<string> => {
    const dId = String(9_500_000_000 + (NS % 100_000) * 100 + Number(suffix));
    await prisma.device.create({ data: { deviceId: dId } });
    await prisma.deviceState.create({
      data: {
        deviceId: dId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 30 * 3_600_000),
        plantId: plant,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId: dId, state: 'OPEN', openedAt: NOW } });
    await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId: dId,
        plantId: plant,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    return dId;
  };

  const openTroubleshootCount = (dId: string) =>
    prisma.ticket.count({ where: { deviceId: dId, workType: 'TROUBLESHOOT', status: 'OPEN' } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    ticketCreation = app.get(TicketCreationService);
    dashboard = app.get(DashboardService);
    recommender = app.get(RecommenderService);

    zoneId = (await prisma.zone.create({ data: { name: `Zpd-${NS}` } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: `Copd-${NS}`, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: `Ppd-${NS}`, zoneId, sourcePlantId: BigInt(NS % 1_000_000_000) } })).plantId;

    // An SE covering the plant, so an OPEN ticket here would otherwise be dispatched (test 4 A/B).
    const tag = randomUUID().slice(0, 8);
    const se = await prisma.user.create({
      data: { name: `SEpd ${tag}`, role: 'SERVICE_ENGINEER', phone: `ph-${tag}`, email: `${tag}@pd.test`, zoneId },
    });
    await prisma.engineerMaster.create({ data: { engineerId: se.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se.userId, plantId, coverageType: 'DEDICATED' } });

    deviceId = await seedInactiveDeviceWithOpenTicket(plantId, '1');
  });

  afterAll(async () => {
    await app.close();
  });

  it('deactivate (OH) cancels the plant open tickets with reason PLANT_DEACTIVATED + audit', async () => {
    const oh = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .post(`/api/plants/${plantId}/deactivate`)
      .set('Authorization', `Bearer ${oh}`)
      .send({ reason: 'STAR CEMENT shutdown (disputed: AutoPlant still ACTIVE)' })
      .expect(200);
    expect(res.body.cancelledTickets).toBe(1);

    const ticket = await prisma.ticket.findFirst({ where: { deviceId, workType: 'TROUBLESHOOT' } });
    expect(ticket?.status).toBe('CLOSED');
    expect(ticket?.closureType).toBe('OPERATIONS_HEAD_OVERRIDE_CLOSE');
    expect(ticket?.closureReason).toContain('PLANT_DEACTIVATED');
    expect(ticket?.closedAt).not.toBeNull();

    const event = await prisma.ticketEvent.findFirst({
      where: { ticketId: ticket!.ticketId, reasonCode: 'PLANT_DEACTIVATED' },
    });
    expect(event?.toState).toBe('CLOSED');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'PLANT_DEACTIVATED', entityType: 'PLANT', entityId: String(plantId) },
    });
    expect(audit).not.toBeNull();

    const cycle = await prisma.failureCycle.findFirst({ where: { deviceId } });
    expect(cycle?.closedAt).not.toBeNull();
  });

  it('excludes the deactivated plant from ticket-creation (no new ticket)', async () => {
    await ticketCreation.createForInactiveEligible(NOW);
    expect(await openTroubleshootCount(deviceId)).toBe(0);
  });

  it('excludes the deactivated plant from dashboard counts', async () => {
    const rows = await dashboard.zoneOverview({ role: 'OPERATIONS_HEAD', zoneId: null });
    expect(rows.find((r) => r.zoneId === String(zoneId))).toBeUndefined();
  });

  it('excludes a deactivated-plant open ticket from dispatch (recommender guard)', async () => {
    // Simulate a leftover/raced OPEN ticket on the deactivated plant.
    const raced = await seedInactiveDeviceWithOpenTicket(plantId, '2');
    const racedTicket = await prisma.ticket.findFirst({ where: { deviceId: raced, status: 'OPEN' } });
    await recommender.runForZone(zoneId, { now: NOW });
    const recs = await prisma.recommendation.count({ where: { ticketId: racedTicket!.ticketId } });
    expect(recs).toBe(0);
  });

  it('survives a master-sync (plant mirror refresh does not touch the deactivation)', async () => {
    // The master-sync update set only rewrites mirrored AutoPlant columns; plant_deactivations is separate.
    await prisma.plant.update({ where: { plantId }, data: { name: `Ppd-${NS}-resynced`, status: 'ACTIVE' } });
    const active = await prisma.plantDeactivation.findFirst({ where: { plantId, reactivatedAt: null } });
    expect(active).not.toBeNull();
  });

  it('reactivate (OH) lets the pipeline re-create a ticket for a still-inactive device', async () => {
    const oh = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post(`/api/plants/${plantId}/reactivate`)
      .set('Authorization', `Bearer ${oh}`)
      .send({ reason: 'DB team confirmed still operational' })
      .expect(200);

    expect(await prisma.plantDeactivation.count({ where: { plantId, reactivatedAt: null } })).toBe(0);

    await ticketCreation.createForInactiveEligible(new Date(NOW.getTime() + 3_600_000));
    expect(await openTroubleshootCount(deviceId)).toBe(1);
  });

  it('enforces the OH-only role matrix + mandatory reason', async () => {
    const csm = await login('csm@fsm.test');
    const zm = await login('zm.north@fsm.test');
    const oh = await login('ops.head@fsm.test');

    await request(app.getHttpServer())
      .post(`/api/plants/${plantId}/deactivate`)
      .set('Authorization', `Bearer ${csm}`)
      .send({ reason: 'x' })
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/plants/deactivations')
      .set('Authorization', `Bearer ${zm}`)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/plants/${plantId}/deactivate`)
      .set('Authorization', `Bearer ${oh}`)
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/plants/deactivations')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
  });
});
