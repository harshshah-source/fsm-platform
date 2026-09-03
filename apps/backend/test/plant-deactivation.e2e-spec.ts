import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TicketCreationService } from '../src/ticketing/ticket-creation.service';
import { DashboardService } from '../src/dashboard/dashboard.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { AuditService } from '../src/audit/audit.service';
import { PlantDeactivationService } from '../src/plant-deactivation/plant-deactivation.service';
import { drainRows } from '../src/scheduling/day-plan-notification-outbox';
import type { DayPlanNotifier, DayPlanOverriddenEvent } from '../src/scheduling/day-plan-notifier';
import { istDate } from '../src/common/ist-day';
import type { RequestActor } from '../src/common/request-actor';

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
        // #238 — recompute derives this from `latestGpsDatetime` below (30 h ago) and ticket creation
        // now reads it rather than the flag, so the fixture has to carry the figure it implied.
        inactivityHours: 30,
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

  /**
   * #345 — spine edge E-26. Deactivating a plant strips its `batch_assignment_tickets` rows inside the
   * deactivate transaction (#241), so an SE's Day Plan silently lost a stop and only "a human
   * remembers" carried the news. The notice is now a `DAY_PLAN_OVERRIDDEN` outbox row written **in that
   * same transaction** (#338's pattern), so it commits with the cancellation or not at all.
   */
  describe('#345 — the SE whose plan lost a stop is told', () => {
    /** The delivery crash: the mutation has committed and the push fails. Durability survives it. */
    class ThrowingOverriddenNotifier implements DayPlanNotifier {
      dayPlanDispatched(): void {}
      dayPlanOverridden(): void {
        throw new Error('notifier down');
      }
    }

    class RecordingNotifier implements DayPlanNotifier {
      overridden: DayPlanOverriddenEvent[] = [];
      dayPlanDispatched(): void {}
      dayPlanOverridden(event: DayPlanOverriddenEvent): void {
        this.overridden.push(event);
      }
    }

    class DayPlanEnqueueFailed extends Error {
      constructor() {
        super('injected: the day-plan enqueue failed');
        this.name = 'DayPlanEnqueueFailed';
      }
    }

    /**
     * The enqueue crash — the only assertion that tells an in-transaction enqueue apart from a
     * post-commit one that merely happens to write a row.
     *
     * A local proxy rather than `test/fixtures/outbox-crash-injection.ts`'s `failingNotifyEnqueue`:
     * that one deliberately lets **day-plan** rows through (it had to, or #338's rollbacks would have
     * been caused by the wrong write), and a day-plan row is exactly what this slice enqueues.
     */
    const failingDayPlanEnqueue = (client: PrismaService): PrismaService => {
      const wrapDelegate = (delegate: object): object =>
        new Proxy(delegate, {
          get(d, dp) {
            if (dp !== 'create') return Reflect.get(d, dp);
            return async (args: { data?: { eventType?: string } }) => {
              if (args?.data?.eventType === 'DAY_PLAN_OVERRIDDEN') throw new DayPlanEnqueueFailed();
              const create = Reflect.get(d, 'create') as (a: unknown) => Promise<unknown>;
              return create.call(d, args);
            };
          },
        });
      const wrapClient = (c: object): object =>
        new Proxy(c, {
          get(target, prop, receiver) {
            if (prop === 'dayPlanNotificationOutbox') {
              return wrapDelegate(Reflect.get(target, prop, receiver) as object);
            }
            if (prop === '$transaction') {
              return (fn: unknown, ...rest: unknown[]) => {
                const real = (target as unknown as Record<string, (...a: unknown[]) => unknown>).$transaction;
                if (typeof fn !== 'function') return real.call(target, fn, ...rest);
                return real.call(target, ((tx: object) => (fn as (t: object) => unknown)(wrapClient(tx))) as never, ...rest);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      return wrapClient(client) as PrismaService;
    };

    // A zone of its own: the outer suite's dashboard AC asserts its zone has vanished because every
    // plant in it is deactivated, and these fixtures must not be able to put a plant back into it.
    let zone345: bigint;
    let seLive: string;
    let seStale: string;
    let ohActor: RequestActor;
    const seIds: string[] = [];

    interface Seeded {
      plantId: bigint;
      plantName: string;
      deviceId: string;
      ticketId: string;
      batchId: bigint | null;
    }
    const seeded: Record<string, Seeded> = {};

    const makeSe = async (label: string): Promise<string> => {
      const tag = randomUUID().slice(0, 8);
      const u = await prisma.user.create({
        data: { name: `SE345 ${label}`, role: 'SERVICE_ENGINEER', phone: `p345-${tag}`, email: `${tag}@pd345.test`, zoneId: zone345 },
      });
      await prisma.engineerMaster.create({
        data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId: zone345, dailyCapacity: 10 },
      });
      seIds.push(u.userId);
      return u.userId;
    };

    /** A plant with one OPEN ticket, optionally sitting as a live stop on `opts.scheduleId`. */
    const seedPlant = async (
      suffix: string,
      opts: { scheduleId?: bigint; seId?: string } = {},
    ): Promise<Seeded> => {
      const plant = await prisma.plant.create({ data: { name: `P345-${suffix}-${NS}`, zoneId: zone345 } });
      const dId = await seedInactiveDeviceWithOpenTicket(plant.plantId, suffix);
      const ticket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: dId, status: 'OPEN' } });
      let batchId: bigint | null = null;
      if (opts.scheduleId !== undefined && opts.seId !== undefined) {
        const batch = await prisma.plantBatchAssignment.create({
          data: {
            scheduleId: opts.scheduleId,
            plantId: plant.plantId,
            seId: opts.seId,
            status: 'AUTO_ASSIGNED',
            stopSequence: Number(suffix),
          },
        });
        batchId = batch.batchId;
        await prisma.batchAssignmentTicket.create({ data: { batchId, ticketId: ticket.ticketId, sortOrder: 1 } });
      }
      return { plantId: plant.plantId, plantName: plant.name, deviceId: dId, ticketId: ticket.ticketId, batchId };
    };

    const overriddenRows = () =>
      prisma.dayPlanNotificationOutbox.findMany({
        where: { eventType: 'DAY_PLAN_OVERRIDDEN', seId: { in: seIds } },
        orderBy: { id: 'asc' },
      });

    beforeAll(async () => {
      zone345 = (await prisma.zone.create({ data: { name: `Z345-${NS}` } })).zoneId;
      seLive = await makeSe('live');
      seStale = await makeSe('stale');

      const today = istDate(new Date());
      const staleDay = istDate(new Date(Date.now() - 3 * 86_400_000));
      const liveSchedule = await prisma.workSchedule.create({
        data: { seId: seLive, zoneId: zone345, dateFrom: today, dateTo: today, status: 'ACTIVE' },
      });
      const staleSchedule = await prisma.workSchedule.create({
        data: { seId: seStale, zoneId: zone345, dateFrom: staleDay, dateTo: staleDay, status: 'ACTIVE' },
      });

      seeded.live = await seedPlant('3', { scheduleId: liveSchedule.scheduleId, seId: seLive });
      seeded.unplanned = await seedPlant('4');
      seeded.stale = await seedPlant('5', { scheduleId: staleSchedule.scheduleId, seId: seStale });
      seeded.durability = await seedPlant('6', { scheduleId: liveSchedule.scheduleId, seId: seLive });
      seeded.atomicity = await seedPlant('7', { scheduleId: liveSchedule.scheduleId, seId: seLive });

      const oh = await prisma.user.findFirstOrThrow({ where: { email: 'ops.head@fsm.test' } });
      ohActor = { userId: oh.userId, role: 'OPERATIONS_HEAD', actedAsRole: null, actingZone: null, zoneId: null };
    });

    afterAll(async () => {
      await prisma.dayPlanNotificationOutbox.deleteMany({ where: { seId: { in: seIds } } });
    });

    it('AC1/AC2 — the SE whose live plan lost a stop gets one row, and it names the plant', async () => {
      const oh = await login('ops.head@fsm.test');
      await request(app.getHttpServer())
        .post(`/api/plants/${seeded.live.plantId}/deactivate`)
        .set('Authorization', `Bearer ${oh}`)
        .send({ reason: 'site closed for the monsoon' })
        .expect(200);

      const rows = await overriddenRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].seId).toBe(seLive);
      expect(rows[0].sentAt).toBeNull();
      const payload = rows[0].payload as { action?: string; batchId?: string; plantName?: string };
      expect(payload.action).toBe('PLANT_DEACTIVATED');
      expect(payload.batchId).toBe(String(seeded.live.batchId));
      // AC2 — the SE has to be able to tell which stop went away.
      expect(payload.plantName).toBe(seeded.live.plantName);

      // The stop really did go away, in the same transaction.
      const link = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { batchId: seeded.live.batchId! } });
      expect(link.removedAt).not.toBeNull();
    });

    it('AC1 — no live stop, no notice: a plant on nobody plan, and a plant on a stale plan', async () => {
      const oh = await login('ops.head@fsm.test');
      for (const plantId of [seeded.unplanned.plantId, seeded.stale.plantId]) {
        await request(app.getHttpServer())
          .post(`/api/plants/${plantId}/deactivate`)
          .set('Authorization', `Bearer ${oh}`)
          .send({ reason: 'no live stop' })
          .expect(200);
      }
      // Still only the first test's row: an SE is told about today's plan, not about a plan that
      // stopped being today's three days ago.
      expect(await overriddenRows()).toHaveLength(1);
    });

    it('durability — the notice survives a failed push, is retried once, and is never delivered twice', async () => {
      const service = new PlantDeactivationService(prisma, new AuditService(prisma));
      const outcome = await service.deactivate(seeded.durability.plantId, 'durability', ohActor);
      expect(outcome.result).toBe('OK');

      const row = await prisma.dayPlanNotificationOutbox.findFirstOrThrow({
        where: { eventType: 'DAY_PLAN_OVERRIDDEN', seId: seLive, payload: { path: ['batchId'], equals: String(seeded.durability.batchId) } },
      });

      // The push fails. The cancellation has already committed and must stay committed.
      await drainRows(prisma, new ThrowingOverriddenNotifier(), [row.id]);
      const cancelled = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: seeded.durability.ticketId } });
      expect(cancelled.status).toBe('CLOSED');
      const failed = await prisma.dayPlanNotificationOutbox.findUniqueOrThrow({ where: { id: row.id } });
      expect(failed.sentAt).toBeNull();
      expect(failed.lastError).toContain('notifier down');

      // The next drain delivers it; a second drain does not deliver it again.
      const notifier = new RecordingNotifier();
      await drainRows(prisma, notifier, [row.id]);
      await drainRows(prisma, notifier, [row.id]);
      expect(notifier.overridden).toHaveLength(1);
      expect(notifier.overridden[0].action).toBe('PLANT_DEACTIVATED');
      expect(notifier.overridden[0].plantName).toBe(seeded.durability.plantName);
      expect((await prisma.dayPlanNotificationOutbox.findUniqueOrThrow({ where: { id: row.id } })).sentAt).not.toBeNull();
    });

    it('atomicity — a failed enqueue rolls the deactivation back with it', async () => {
      // #338's trap: `withAudit` opens its transaction on the AuditService's OWN client, so the
      // interfering proxy has to be handed to both or the write under test never sees it.
      const proxied = failingDayPlanEnqueue(prisma);
      const service = new PlantDeactivationService(proxied, new AuditService(proxied));

      await expect(service.deactivate(seeded.atomicity.plantId, 'atomicity', ohActor)).rejects.toThrow(
        'the day-plan enqueue failed',
      );

      // Asserted on the MUTATION, never on the notice.
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: seeded.atomicity.ticketId } });
      expect(ticket.status).toBe('OPEN');
      expect(ticket.closedAt).toBeNull();
      expect(await prisma.plantDeactivation.count({ where: { plantId: seeded.atomicity.plantId } })).toBe(0);
      expect(
        await prisma.auditLog.count({
          where: { action: 'PLANT_DEACTIVATED', entityType: 'PLANT', entityId: String(seeded.atomicity.plantId) },
        }),
      ).toBe(0);
      const link = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { batchId: seeded.atomicity.batchId! } });
      expect(link.removedAt).toBeNull();
    });

    it('AC3 — reactivation is unchanged: it restores no ticket, no stop and no notice', async () => {
      const before = (await overriddenRows()).length;
      const oh = await login('ops.head@fsm.test');
      await request(app.getHttpServer())
        .post(`/api/plants/${seeded.live.plantId}/reactivate`)
        .set('Authorization', `Bearer ${oh}`)
        .send({ reason: 'reopened' })
        .expect(200);

      expect(await overriddenRows()).toHaveLength(before);
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: seeded.live.ticketId } });
      expect(ticket.status).toBe('CLOSED');
      const link = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { batchId: seeded.live.batchId! } });
      expect(link.removedAt).not.toBeNull();
    });
  });
});
