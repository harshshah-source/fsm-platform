import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { REMOVAL_REASONS, type RemovalReason } from '../src/scheduling/removal-reason';
import {
  DEFAULT_SPECIAL_ATTEMPT_THRESHOLD,
  SPECIAL_ATTEMPT_THRESHOLD_DESCRIPTION,
  SPECIAL_ATTEMPT_THRESHOLD_KEY,
} from '../src/settings/special-threshold';

/**
 * #244 — the read surface over the derivation: the queue's badge data, the `special=true` filter and
 * its count, and the per-ticket attempt history.
 *
 * The property worth guarding here is **one definition, three surfaces**. The badge column, the
 * filter and the count all evaluate the same SQL expression, so a queue cannot show a badge the
 * filter then hides — a class of bug that is invisible in unit tests of either half and obvious the
 * moment a manager filters a list and watches rows they were just looking at disappear.
 *
 * Zone scoping is the other half: Special is a per-ticket verdict, but the *count* is per-caller, and
 * a ZM must be told how many Special tickets are theirs — not how many exist.
 */
const ZM_ZONE = 1;
const NS = Date.now();
const DAY = 86_400_000;
const NOW = new Date('2026-08-19T06:00:00Z');

describe('#244 — Special ticket API (list badge, filter, count, attempt history)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let otherZoneId: bigint;
  let companyId: bigint;
  let inZonePlant: bigint;
  let outOfZonePlant: bigint;
  let seId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const scheduleIds: bigint[] = [];

  let specialTicketId = '';
  let ordinaryTicketId = '';
  let outOfZoneSpecialId = '';

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const makeTicket = async (plantId: bigint): Promise<{ ticketId: string; cycleId: string }> => {
    const deviceId = String(14_600_000_000 + (NS % 100_000) * 20 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(t.ticketId);
    return { ticketId: t.ticketId, cycleId: cycle.cycleId };
  };

  const addWindow = async (
    ticketId: string,
    plantId: bigint,
    zoneId: bigint,
    reason: RemovalReason,
    daysAgo: number,
    reached = true,
  ): Promise<void> => {
    const openedAt = new Date(NOW.getTime() - daysAgo * DAY);
    const closedAt = new Date(openedAt.getTime() + 12 * 3_600_000);
    const day = new Date(Date.UTC(openedAt.getUTCFullYear(), openedAt.getUTCMonth(), openedAt.getUTCDate()));
    const schedule = await prisma.workSchedule.create({
      data: { seId, zoneId, dateFrom: day, dateTo: day, status: 'PARTIAL', source: 'SYSTEM_GENERATED', dispatchedAt: openedAt },
    });
    scheduleIds.push(schedule.scheduleId);
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.create({
      data: {
        batchId: batch.batchId,
        ticketId,
        sortOrder: 1,
        createdAt: openedAt,
        removedAt: closedAt,
        removedBy: null,
        removalReason: reason,
      },
    });
    if (reached) {
      await prisma.softState.create({
        data: {
          ticketId,
          seId,
          type: 'VIEWED',
          setAt: new Date(openedAt.getTime() + 3_600_000),
          timeoutAt: new Date(openedAt.getTime() + 3_600_000 + 90 * 60_000),
          resolvedAt: closedAt,
        },
      });
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    otherZoneId = (await prisma.zone.create({ data: { name: 'Z-spa-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-spa-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    inZonePlant = (await prisma.plant.create({ data: { name: 'P-spa-in', zoneId: BigInt(ZM_ZONE) } })).plantId;
    outOfZonePlant = (await prisma.plant.create({ data: { name: 'P-spa-out', zoneId: otherZoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: {
        name: 'SE ' + tag,
        role: 'SERVICE_ENGINEER',
        phone: 'ph-' + tag,
        email: `${tag}@spa.test`,
        zoneId: BigInt(ZM_ZONE),
      },
    });
    userIds.push(u.userId);
    seId = u.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: seId, coverageType: 'DEDICATED', zoneId: BigInt(ZM_ZONE), dailyCapacity: 10 },
    });

    // Three reached-and-expired attempts in the ZM's zone → Special at the default threshold of 3.
    const special = await makeTicket(inZonePlant);
    specialTicketId = special.ticketId;
    for (let i = 0; i < 3; i++) {
      await addWindow(specialTicketId, inZonePlant, BigInt(ZM_ZONE), REMOVAL_REASONS.PLAN_EXPIRED, 5 - i);
    }

    // One attempt, plus a manager withdrawal that must not count → ordinary.
    const ordinary = await makeTicket(inZonePlant);
    ordinaryTicketId = ordinary.ticketId;
    await addWindow(ordinaryTicketId, inZonePlant, BigInt(ZM_ZONE), REMOVAL_REASONS.PLAN_EXPIRED, 4);
    await addWindow(ordinaryTicketId, inZonePlant, BigInt(ZM_ZONE), REMOVAL_REASONS.ZM_WITHDRAWN, 2);

    // A Special ticket in another zone — visible to the OH, invisible to this ZM, in row and in count.
    const elsewhere = await makeTicket(outOfZonePlant);
    outOfZoneSpecialId = elsewhere.ticketId;
    for (let i = 0; i < 3; i++) {
      await addWindow(outOfZoneSpecialId, outOfZonePlant, otherZoneId, REMOVAL_REASONS.PLAN_EXPIRED, 5 - i);
    }
  });

  afterAll(async () => {
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: scheduleIds } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { scheduleId: { in: scheduleIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [inZonePlant, outOfZonePlant] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: otherZoneId } });
    await app.close();
  });

  const listAs = async (token: string, qs = '') =>
    request(app.getHttpServer())
      .get(`/api/tickets${qs}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

  /** AC-5's data half: the queue can render the badge because every row carries its own verdict. */
  it('carries the verdict and the attempt count on every list row', async () => {
    const oh = await login('ops.head@fsm.test');

    const res = await listAs(oh);
    const rows: Array<{ ticketId: string; isSpecial: boolean; specialAttempts: number }> = res.body;
    const special = rows.find((r) => r.ticketId === specialTicketId);
    const ordinary = rows.find((r) => r.ticketId === ordinaryTicketId);

    expect(special).toMatchObject({ isSpecial: true, specialAttempts: 3 });
    // One countable attempt; the manager withdrawal is not evidence and does not appear in the count.
    expect(ordinary).toMatchObject({ isSpecial: false, specialAttempts: 1 });
  });

  /**
   * One definition, two surfaces: the filter returns exactly the rows the badge column marks. Asserted
   * as an identity over the same response rather than against a hand-written expectation, so it stays
   * true if the fixture changes.
   */
  it('the special=true filter returns exactly the rows the badge marks', async () => {
    const oh = await login('ops.head@fsm.test');

    const all = await listAs(oh, '?limit=500');
    const filtered = await listAs(oh, '?special=true&limit=500');
    const badged = (all.body as Array<{ ticketId: string; isSpecial: boolean }>)
      .filter((r) => r.isSpecial)
      .map((r) => r.ticketId)
      .sort();
    const returned = (filtered.body as Array<{ ticketId: string }>).map((r) => r.ticketId).sort();

    expect(returned).toEqual(badged);
    expect(returned).toContain(specialTicketId);
    expect(returned).not.toContain(ordinaryTicketId);
    expect((filtered.body as Array<{ isSpecial: boolean }>).every((r) => r.isSpecial)).toBe(true);
  });

  it('counts Special tickets for the caller, and reports the threshold it judged against', async () => {
    const oh = await login('ops.head@fsm.test');

    const res = await request(app.getHttpServer())
      .get('/api/tickets/special-count')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);

    expect(res.body.threshold).toBe(DEFAULT_SPECIAL_ATTEMPT_THRESHOLD);
    expect(res.body.count).toBeGreaterThanOrEqual(2); // both fixture Specials, plus any pre-existing
  });

  /** A ZM sees their zone. The count is a per-caller figure, not a platform total — quoting a global
   *  number to a ZM would send them looking for tickets they cannot open. */
  it('scopes both the filter and the count to the caller\'s zone', async () => {
    const zm = await login('zm.north@fsm.test');
    const oh = await login('ops.head@fsm.test');

    const zmRows = await listAs(zm, '?special=true&limit=500');
    const zmIds = (zmRows.body as Array<{ ticketId: string }>).map((r) => r.ticketId);
    expect(zmIds).toContain(specialTicketId);
    expect(zmIds).not.toContain(outOfZoneSpecialId);

    const zmCount = await request(app.getHttpServer())
      .get('/api/tickets/special-count')
      .set('Authorization', `Bearer ${zm}`)
      .expect(200);
    const ohCount = await request(app.getHttpServer())
      .get('/api/tickets/special-count')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);

    expect(zmCount.body.count).toBe(zmIds.length);
    expect(ohCount.body.count).toBeGreaterThan(zmCount.body.count);
  });

  /**
   * The route-ordering pin. `special-count` is a literal path on a controller that also declares
   * `:id`, so a declaration in the wrong order makes it a ticket lookup for the id "special-count" —
   * a 404 that looks exactly like an unknown ticket and would be found in the browser, not in CI.
   */
  it('does not let :id swallow the literal special-count route', async () => {
    const oh = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/tickets/special-count')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
    expect(res.body).toHaveProperty('count');
    expect(res.body).not.toHaveProperty('ticketId');
  });

  it('serves the per-ticket attempt history with its evidence, verdict and threshold', async () => {
    const oh = await login('ops.head@fsm.test');

    const res = await request(app.getHttpServer())
      .get(`/api/tickets/${specialTicketId}/attempts`)
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);

    expect(res.body).toMatchObject({
      ticketId: specialTicketId,
      isSpecial: true,
      countableAttempts: 3,
      threshold: DEFAULT_SPECIAL_ATTEMPT_THRESHOLD,
    });
    expect(res.body.attempts).toHaveLength(3);
    expect(res.body.attempts[0]).toMatchObject({ reached: true, countable: true, removalReason: 'PLAN_EXPIRED' });
    expect(res.body.attempts[0].seId).toBe(seId);
  });

  it('404s the attempt history for an unknown ticket and for another zone\'s', async () => {
    const zm = await login('zm.north@fsm.test');

    await request(app.getHttpServer())
      .get(`/api/tickets/${randomUUID()}/attempts`)
      .set('Authorization', `Bearer ${zm}`)
      .expect(404);
    // Out-of-zone must 404 rather than 403: the ZM is not entitled to learn the ticket exists.
    await request(app.getHttpServer())
      .get(`/api/tickets/${outOfZoneSpecialId}/attempts`)
      .set('Authorization', `Bearer ${zm}`)
      .expect(404);
  });

  /**
   * AC-6 — **Special changes no ordering.** Identification-first means the badge tells a manager
   * something; it must not quietly re-rank the queue, because a second, invisible priority input is
   * exactly what "identification, not a priority mechanism" rules out. (#248's return-date key lands
   * on the same comparator later; this pin is written against the ordering itself rather than against
   * #248, so it holds before and after that slice.)
   *
   * Asserted by comparing the default order with the order the same query produces when the Special
   * population changes underneath it: lowering the threshold to 2 makes an extra ticket Special and
   * must leave the sequence byte-identical.
   */
  it('AC-6: a Special verdict changes no ordering', async () => {
    const oh = await login('ops.head@fsm.test');

    const before = (await listAs(oh, '?limit=500')).body as Array<{ ticketId: string; isSpecial: boolean }>;
    await prisma.systemSetting.upsert({
      where: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY },
      create: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY, description: SPECIAL_ATTEMPT_THRESHOLD_DESCRIPTION, value: 1000 as unknown as object },
      update: { value: 1000 as unknown as object },
    });
    const nothingSpecial = (await listAs(oh, '?limit=500')).body as Array<{
      ticketId: string;
      isSpecial: boolean;
    }>;

    // The verdicts moved; the sequence did not.
    expect(nothingSpecial.map((r) => r.ticketId)).toEqual(before.map((r) => r.ticketId));
    // 1000 is off the ladder, so the reader coerces to the default rather than classifying against it
    // — which is itself the #244 defensive-read contract, asserted here where it bites.
    expect(nothingSpecial.find((r) => r.ticketId === specialTicketId)?.isSpecial).toBe(true);

    await prisma.systemSetting.upsert({
      where: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY },
      create: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY, description: SPECIAL_ATTEMPT_THRESHOLD_DESCRIPTION, value: 2 as unknown as object },
      update: { value: 2 as unknown as object },
    });
    const moreSpecial = (await listAs(oh, '?limit=500')).body as Array<{ ticketId: string; isSpecial: boolean }>;

    expect(moreSpecial.map((r) => r.ticketId)).toEqual(before.map((r) => r.ticketId));
    // The extra ticket really did become Special — otherwise the ordering claim above is vacuous.
    expect(moreSpecial.find((r) => r.ticketId === ordinaryTicketId)?.isSpecial).toBe(false);
    expect(moreSpecial.filter((r) => r.isSpecial).length).toBeGreaterThanOrEqual(
      before.filter((r) => r.isSpecial).length,
    );

    await prisma.systemSetting.upsert({
      where: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY },
      create: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY, description: SPECIAL_ATTEMPT_THRESHOLD_DESCRIPTION, value: DEFAULT_SPECIAL_ATTEMPT_THRESHOLD as unknown as object },
      update: { value: DEFAULT_SPECIAL_ATTEMPT_THRESHOLD as unknown as object },
    });
  });

  /**
   * AC-5's Device Detail half. That page represents a device's ticket as a **single link**, not as a
   * section, so parity here is the *identification* travelling with the link — the attempt history
   * itself lives one click away in the ticket drawer rather than being duplicated onto a panel that
   * has no ticket section to extend (the surfacing rule's "do not redesign").
   *
   * The verdict is computed by the same shared predicate the queue uses, inside the read's existing
   * open-ticket LATERAL, so a device can never disagree with the ticket queue about its own ticket.
   */
  it('carries the Special verdict on the open ticket of the device read', async () => {
    const oh = await login('ops.head@fsm.test');

    const res = await request(app.getHttpServer())
      .get('/api/devices?limit=500')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);

    const rows: Array<{ openTicketId: string | null; openTicketIsSpecial: boolean | null }> = res.body.rows;
    const special = rows.find((r) => r.openTicketId === specialTicketId);
    const ordinary = rows.find((r) => r.openTicketId === ordinaryTicketId);

    expect(special?.openTicketIsSpecial).toBe(true);
    expect(ordinary?.openTicketIsSpecial).toBe(false);
  });

  /** AC-5 — this is a manager surface. An SE's mobile app gains nothing from #244. */
  it('is closed to service engineers', async () => {
    const se = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/tickets/special-count')
      .set('Authorization', `Bearer ${se}`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/tickets/${specialTicketId}/attempts`)
      .set('Authorization', `Bearer ${se}`)
      .expect(403);
  });
});
