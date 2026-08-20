import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { istDate } from '../src/common/ist-day';
import { PrismaService } from '../src/prisma/prisma.service';
import { EngineersQueryService } from '../src/engineers/engineers-query.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { ZmScheduleQueryService } from '../src/scheduling/zm-schedule-query.service';

/**
 * #269 — an SE's committed day load against their `daily_capacity` is **visible** wherever a manager
 * assigns or reviews work. Decision #258 **Q2**: overload is an administrative right, so this is
 * visibility only — never a block, never a forced confirmation.
 *
 * **The one definition.** "Committed" was spelled three different ways before this issue:
 * `RecommenderService.committedDayLoad` (the enforcement authority — live batch rows on a live
 * schedule *covering the day*), `EngineersQueryService.activeTicketCountBySe` (the same shape but
 * with **no date filter** and an extra batch-status filter, so it counted a multi-day plan's whole
 * range against today) and `ZmScheduleRow.ticketCount` (one schedule, not one day). Three counters
 * that can legitimately disagree, about to be rendered beside one capacity denominator. #269 collapses
 * the first two onto `committedDayLoad` in `src/scheduling/committed-day-load.ts` and the AC that
 * matters most is the agreement test below: **what the manager is shown is what the engine enforces.**
 *
 * The `committedDayLoad` overcount #178 fixed (a ticket closed at 10:00 kept burning a slot) is why
 * #178 was a hard prerequisite here — a badge is a claim of fact, and this one had to be true first.
 */
const NS = Date.now();
const NOW = new Date('2026-06-24T09:00:00Z');
/** The IST calendar day containing NOW — `@db.Date` columns compare at UTC midnight of that date. */
const TODAY = new Date('2026-06-24T00:00:00Z');
const YESTERDAY = new Date('2026-06-23T00:00:00Z');

describe('#269 — capacity overload visibility', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;
  let zm: ZmScheduleQueryService;
  let engineers: EngineersQueryService;
  let rec: RecommenderService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  /** Capacity 3, loaded to 2 — the "has room" case. */
  let roomySe: string;
  /** Capacity 2, loaded to 2 — the at-capacity case the pickers must mark and still allow. */
  let fullSe: string;
  let zmToken: string;

  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const makeSe = async (dailyCapacity: number): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@cap.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity },
    });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    return u.userId;
  };

  /** A CRITICAL OPEN troubleshoot ticket at the shared plant, `gpsAgeMin` old. */
  const makeTicket = async (gpsAgeMin: number): Promise<string> => {
    const deviceId = String(12_690_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - gpsAgeMin * 60_000),
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
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
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  /**
   * Put `count` live day-plan stops on `se` for the given date range — schedule → batch → live
   * `batch_assignment_tickets` rows, the exact shape a dispatch leaves behind. Built directly rather
   * than through a dispatch run so each test states its own load precisely; the agreement test below
   * deliberately uses the real recommender instead.
   */
  const loadSe = async (
    se: string,
    count: number,
    range: { dateFrom: Date; dateTo: Date } = { dateFrom: TODAY, dateTo: TODAY },
  ): Promise<void> => {
    const schedule = await prisma.workSchedule.create({
      data: { seId: se, zoneId, dateFrom: range.dateFrom, dateTo: range.dateTo, status: 'ACTIVE', dispatchedAt: NOW },
    });
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId: se, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    for (let i = 0; i < count; i++) {
      const ticketId = await makeTicket(60 + i);
      await prisma.ticket.update({ where: { ticketId }, data: { assignmentState: 'FORMALLY_ASSIGNED' } });
      await prisma.batchAssignmentTicket.create({
        data: { batchId: batch.batchId, ticketId, sortOrder: i + 1 },
      });
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    zm = new ZmScheduleQueryService(prisma);
    engineers = new EngineersQueryService(prisma);
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-cap-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-cap-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-cap-' + NS, zoneId } })).plantId;

    roomySe = await makeSe(3);
    fullSe = await makeSe(2);
    await loadSe(roomySe, 2);
    await loadSe(fullSe, 2);
    // Yesterday's plan, still ACTIVE because nothing closed it — the discriminator that makes every
    // assertion below sensitive rather than agreeable. A counter without the date predicate reads
    // roomySe at 4/3 and calls them overloaded; the correct one reads 2/3 and says they have room.
    // (`work_schedules_one_active_per_se_zone_day` is keyed on `date_from`, so this coexists.)
    await loadSe(roomySe, 2, { dateFrom: YESTERDAY, dateTo: YESTERDAY });

    const zmTag = randomUUID().slice(0, 8);
    const zmUser = await prisma.user.create({
      data: { name: 'ZM ' + zmTag, role: 'ZONAL_MANAGER', phone: 'ph-' + zmTag, email: `${zmTag}@cap.test`, zoneId },
    });
    userIds.push(zmUser.userId);
    zmToken = tokens.signAccessToken({ user_id: zmUser.userId, role: 'ZONAL_MANAGER', zone_id: Number(zoneId) });
  });

  afterAll(async () => {
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  /**
   * Slice 1 — the picker source. `/schedules/engineers` already carried `dailyCapacity` and rendered
   * it in **zero** places because it had no numerator; `committed` is that numerator, and it is the
   * one field every `ZoneEngineer` picker (Critical queue, Swap/Reassign/Split, planner, commissioning
   * cohort) reads, so one backend field lights up four surfaces.
   */
  it('reports each SE\'s committed day load beside their capacity on the zone-engineer picker source', async () => {
    const rows = await zm.listZoneEngineers({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) }, NOW);

    const roomy = rows.find((r) => r.engineerId === roomySe);
    expect(roomy).toBeDefined();
    expect(roomy!.committed).toBe(2);
    expect(roomy!.dailyCapacity).toBe(3);

    const full = rows.find((r) => r.engineerId === fullSe);
    expect(full).toBeDefined();
    expect(full!.committed).toBe(2);
    expect(full!.dailyCapacity).toBe(2);
  });

  /**
   * Slice 2 — AC-3, the load-bearing one. **What the manager is shown is what the engine enforces.**
   *
   * Both seams are exercised for real: the picker read on one side, a #250 dry run of the actual
   * recommender on the other. The fixture makes them discriminating rather than agreeable — `fullSe`
   * sits at exactly `2/2` and `roomySe` at `2/3`, so a run that pools one more ticket at their shared
   * plant must drop precisely the engineer the picker marks and choose precisely the one it does not.
   *
   * This is an **invariant pin, green from the moment the shared predicate landed** — the value is in
   * what it forbids later, not in a red it produced. Its sensitivity was verified rather than assumed:
   * deleting the date predicate from `committedDayLoad` turns this test red alongside slice 1, and it
   * fails in exactly the shape the defect would take in the field — the run reports `seId: null`,
   * *nobody available*, while two engineers demonstrably have room. A future "helpful"
   * divergence (a display that zone-scopes the load, an enforcement path that starts filtering batch
   * status) fails here rather than reaching a manager who was told an engineer was full.
   */
  it('shows the same committed figure the recommender enforces against, engineer for engineer', async () => {
    // One more ticket at the shared plant, old enough to clear the #238 assignment threshold so it
    // actually enters the run pool. OPEN + UNASSIGNED — the load fixtures above are FORMALLY_ASSIGNED
    // and are therefore the *load*, not the work being decided.
    const deciding = await makeTicket(48 * 60);
    await prisma.deviceState.update({
      where: { deviceId: deviceIds[deviceIds.length - 1] },
      data: { inactivityHours: 48 },
    });

    const shown = await zm.listZoneEngineers({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) }, NOW);
    const summary = await rec.runForZone(zoneId, { now: NOW, dryRun: true });
    const decision = summary.projection?.decisions.find((d) => d.ticketId === deciding);
    expect(decision).toBeDefined();

    // The engine's verdict, per engineer.
    expect(decision!.seId).toBe(roomySe);
    expect(decision!.dropCounts.OVER_CAPACITY).toBe(1);

    // The picker's claim, per engineer — derived from `shown`, never recomputed the way the code does.
    const overCapacityInPicker = shown
      .filter((r) => r.committed >= r.dailyCapacity)
      .map((r) => r.engineerId);
    expect(overCapacityInPicker).toEqual([fullSe]);

    // And the chosen engineer's load at the moment of decision is the displayed figure plus the stop
    // this very run is handing them — the two numbers are the same counter, one tick apart.
    expect(decision!.capacityAtDecision).toEqual({
      used: shown.find((r) => r.engineerId === roomySe)!.committed + 1,
      cap: 3,
    });
  });

  /**
   * Slice 3 — the second counter, retired. `EngineersQueryService.activeTicketCountBySe` answered
   * "how loaded is this SE?" with **no date filter**, so `roomySe`'s still-ACTIVE plan from yesterday
   * counted against today and the SE Management directory reported them carrying 4. Nothing caught it
   * because the number was rendered bare, with no denominator to make it absurd. #269 puts
   * `dailyCapacity` next to it, so it now has to be the same figure the engine enforces.
   *
   * The field keeps its name and the response shape is unchanged — this is a correction to what the
   * number *means*, not a new field. (#178's schedule-closure recycle is what stops such a plan
   * lingering in the first place; the date predicate is the defence that does not depend on a sweep
   * having run.)
   */
  it('counts only today against today on the SE directory row, ignoring a still-live plan from yesterday', async () => {
    const rows = await engineers.listForZone({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) }, NOW);

    const roomy = rows.find((r) => r.seId === roomySe);
    expect(roomy).toBeDefined();
    expect(roomy!.activeTicketCount).toBe(2); // 2 today; yesterday's 2 are not today's work
    expect(roomy!.dailyCapacity).toBe(3);

    // And it is the same number the picker shows — one definition, two read models.
    const picker = await zm.listZoneEngineers({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) }, NOW);
    expect(roomy!.activeTicketCount).toBe(picker.find((r) => r.engineerId === roomySe)!.committed);
  });

  /**
   * Slice 4 — AC-4, the **non-gate**, pinned by regression test because it is a rule about what the
   * system must never start doing.
   *
   * #258 **Q2** ruled manual overload an administrative right: capacity is a *planning* constraint the
   * automatic paths respect, not an authorisation the manager needs. So the moment `committed / cap`
   * appears on a picker, the obvious next "improvement" is to refuse the assignment, or to demand a
   * confirmation, or to make it an audited exception — and every one of those would quietly convert a
   * dispatcher's judgement call into a request for permission. A manager who can see the load and
   * decides to overload anyway is doing their job.
   *
   * Driven over HTTP as a real ZONAL_MANAGER, at an SE the picker itself marks over capacity, with **no
   * `confirm` and no `reasonCode` in the body**. Anything less than a plain 200 is the regression.
   */
  it('assigns to an at-capacity SE with no confirm, no reason and no refusal', async () => {
    // This one case runs on the **wall clock**, unlike its neighbours. `POST /schedules/assign` stamps
    // `new Date()` (`schedules.controller.ts:313`) and there is no clock seam on the HTTP path, so the
    // plan it writes into is the real operating day. A fixture frozen at the file's `NOW` would have
    // the endpoint quietly build a *second*, present-day schedule and the assertion would then be
    // measuring the wrong day rather than the refusal it exists to forbid.
    const today = istDate(new Date());
    const wallClockSe = await makeSe(1);
    await loadSe(wallClockSe, 1, { dateFrom: today, dateTo: today });
    const overloading = await makeTicket(30);

    const before = await zm.listZoneEngineers({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
    const target = before.find((r) => r.engineerId === wallClockSe)!;
    expect(target.committed).toBeGreaterThanOrEqual(target.dailyCapacity); // the fixture is the point

    const res = await request(app.getHttpServer())
      .post('/api/schedules/assign')
      .set('Authorization', `Bearer ${zmToken}`)
      .send({ ticketId: overloading, seId: wallClockSe });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('OK');
    expect(res.body.seId).toBe(wallClockSe);

    // The work really landed, and the badge now says so — an overload that is *visible* rather than
    // prevented is the whole of Q2.
    const after = await zm.listZoneEngineers({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
    expect(after.find((r) => r.engineerId === wallClockSe)!.committed).toBe(target.committed + 1);
  });
});
