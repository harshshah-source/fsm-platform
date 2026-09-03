import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CONCLUDED_REMOVAL_REASONS, MeWorkHistoryService } from '../src/me-tickets/me-work-history.service';
import { ALL_REMOVAL_REASONS, REMOVAL_REASONS, type RemovalReason } from '../src/scheduling/removal-reason';
import { AutoRecoveryService } from '../src/ticketing/auto-recovery.service';
import { TroubleshootSubmissionService } from '../src/ticketing/troubleshoot-submission.service';
import { VerificationService } from '../src/verification/verification.service';

/**
 * #175 — `GET /api/me/work-history`, the per-day assigned/completed series behind the Home screen's
 * "Assigned vs Completed" chart (`docs/ui/mobile/home-dashboard.png`).
 *
 * The clock is pinned: `NOW` is 11:30 IST on 2026-06-21, so a `days=7` request covers the IST days
 * 06-15 … 06-21. Every fixture instant below is chosen to sit on a specific side of an IST midnight —
 * that is the behaviour under test, not incidental setup.
 *
 * **#297 (CB-1) — why every closure here goes through a real writer.** This spec used to fabricate
 * closures with a bare `ticketEvent.create`, which produces an event and leaves the
 * `batch_assignment_tickets` row untouched. Since #178 no production path can reach that state: every
 * terminal closure retires the row in the same transaction (`scheduling/close-assignment.ts`). The
 * fixture was therefore describing a world the system had stopped producing, and it went on passing
 * while the live chart showed completed ≈ 0 and assigned *shrinking* as work got done. Closure state
 * is now only ever created by `VerificationService` / `AutoRecoveryService`; removal state carries the
 * reason column the real writers stamp, and every member of that vocabulary is pinned to a bucket.
 */
const NS = Date.now();
const NOW = new Date('2026-06-21T06:00:00Z'); // 11:30 IST, 2026-06-21
/** Every failure cycle opens well before the earliest fixture instant, so no closure runs backwards. */
const EPOCH = new Date('2026-06-01T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC midnight of an IST calendar date — the form `@db.Date` columns marshal to. */
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** A batch row that is not live: the reason its real writer would have stamped, or `null` for the
 *  pre-#241 shape (removed with no cause recorded), which must never be read as finished work. */
type RemovedRow = { ticketId: string; reason: RemovalReason | null };

describe('#175 — GET /api/me/work-history (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;
  let history: MeWorkHistoryService;
  let submissions: TroubleshootSubmissionService;
  let verify: VerificationService;
  let autoRecovery: AutoRecoveryService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let otherSe: string;
  let opsHead: string;
  let snapshotRunId: bigint;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(9_840_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: EPOCH } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        assignmentState: 'FORMALLY_ASSIGNED',
        lastStateChangedAt: EPOCH,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  /** One schedule covering `[from, to]` with a single plant batch holding `tickets` live. `removed`
   *  rows ride the same batch already retired, each carrying the reason its real writer stamps. */
  const makeSchedule = async (
    seId: string,
    from: string,
    to: string,
    tickets: string[],
    removed: RemovedRow[] = [],
  ): Promise<void> => {
    const schedule = await prisma.workSchedule.create({
      data: { seId, zoneId, dateFrom: day(from), dateTo: day(to), status: 'ACTIVE', dispatchedAt: NOW },
    });
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.createMany({
      data: [
        ...tickets.map((ticketId, i) => ({ batchId: batch.batchId, ticketId, sortOrder: i + 1 })),
        ...removed.map((row, i) => ({
          batchId: batch.batchId,
          ticketId: row.ticketId,
          sortOrder: tickets.length + i + 1,
          removedAt: NOW,
          removalReason: row.reason,
        })),
      ],
    });
  };

  /**
   * The normal end of a troubleshoot, driven end to end: the SE submits the form, the device pings
   * through the verification window, and `VerificationService` decides. That transaction is what
   * stamps the `CLOSED` event **and** retires the batch row with `TICKET_RESOLVED` — the pairing this
   * spec exists to exercise. `closedAt` is the instant the event carries, so it is what the chart
   * buckets by; the submission is anchored 70 minutes earlier, the shortest run that passes Phase 2.
   */
  const closeByVerification = async (ticketId: string, closedAt: Date, seId = se): Promise<void> => {
    const submittedAt = new Date(closedAt.getTime() - 70 * 60_000);
    const { deviceId } = await prisma.ticket.findUniqueOrThrow({
      where: { ticketId },
      select: { deviceId: true },
    });
    const anchor = { lat: 12.9716, lon: 77.5946 };
    await submissions.submit({
      ticketId,
      seId,
      clientSubmissionId: randomUUID(),
      rootCauseCategory: 'POWER_ISSUE',
      seGps: anchor,
      presenceSource: 'FORM_GPS',
      actor: { userId: seId, role: 'SERVICE_ENGINEER', actedAsRole: null },
      now: submittedAt,
    });
    for (const m of [1, 20, 45, 65]) {
      await prisma.rawDeviceSnapshot.create({
        data: {
          runId: snapshotRunId,
          deviceId,
          gpsDatetime: new Date(submittedAt.getTime() + m * 60_000),
          lat: 12.9721,
          lon: 77.5946,
        },
      });
    }
    const res = await verify.runVerification(closedAt, { ticketIds: [ticketId] });
    expect(res.closed).toBe(1);
  };

  /** The other closure family: a manager marks the device self-healed. Writes a `CLOSED_AUTO_RECOVERY`
   *  event and retires the row with `AUTO_RECOVERY` — a real closure that credits no SE effort, so it
   *  must stay in `assigned` and score 0 in `completed` (#229 D6). */
  const closeByAutoRecovery = async (ticketId: string, closedAt: Date): Promise<void> => {
    const result = await autoRecovery.manualClose(
      ticketId,
      { role: 'OPERATIONS_HEAD', zoneId: null },
      { userId: opsHead, role: 'OPERATIONS_HEAD', actedAsRole: null },
      closedAt,
    );
    expect(result).toBe('CLOSED');
  };

  const seToken = (userId = se) =>
    tokens.signAccessToken({ user_id: userId, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });

  const makeSe = async (): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'wh-' + tag, email: `${tag}@wh.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    return u.userId;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    history = app.get(MeWorkHistoryService);
    submissions = app.get(TroubleshootSubmissionService);
    verify = app.get(VerificationService);
    autoRecovery = app.get(AutoRecoveryService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-wh-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-wh-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-wh-' + NS, zoneId } })).plantId;
    snapshotRunId = (await prisma.snapshotRun.create({ data: { status: 'SUCCESS', dataAsOf: NOW } })).runId;
    se = await makeSe();
    otherSe = await makeSe();

    // The auto-recovery close needs a real manager: `removed_by` and the audit actor are UUID columns.
    const ohTag = randomUUID().slice(0, 8);
    const oh = await prisma.user.create({
      data: { name: 'OH ' + ohTag, role: 'OPERATIONS_HEAD', phone: 'wh-' + ohTag, email: `${ohTag}@wh.test`, zoneId },
    });
    userIds.push(oh.userId);
    opsHead = oh.userId;
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
    await prisma.verificationRun.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.rawDeviceSnapshot.deleteMany({ where: { runId: snapshotRunId } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.snapshotRun.deleteMany({ where: { runId: snapshotRunId } });
    await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  /**
   * #297 AC1 — the SE is dispatched N tickets and finishes M of them through the real
   * troubleshoot → verification path. Before the fix each of those M closures retired its batch row
   * and so deleted the ticket from *both* series: the 19th read `assigned: 0, completed: 0` however
   * much work got done, and grew *worse* the more the SE finished.
   */
  it('returns a dense 7-day series with assigned/completed per IST day, zero rows included', async () => {
    const [t1, t2, t3, t4, t5, t6] = await Promise.all([
      makeTicket(), makeTicket(), makeTicket(), makeTicket(), makeTicket(), makeTicket(),
    ]);

    // 06-19: three assigned. 06-21 (today): two assigned, plus one the ZM withdrew from the plan.
    // No ticket appears live in both batches — `batch_assignment_tickets` carries a partial-unique
    // `(ticket_id) WHERE removed_at IS NULL` ("one active batch per ticket", schema.prisma:685), so a
    // fixture that reused one would be describing a state the database cannot hold.
    await makeSchedule(se, '2026-06-19', '2026-06-19', [t1, t2, t3]);
    await makeSchedule(se, '2026-06-21', '2026-06-21', [t4, t6], [
      { ticketId: t5, reason: REMOVAL_REASONS.ZM_WITHDRAWN },
    ]);

    await closeByVerification(t1, new Date('2026-06-19T10:00:00Z')); // 15:30 IST on the 19th
    // 00:15 IST on the 19th. Under UTC-midnight bucketing this lands on the 18th, where t3 is not
    // assigned, and would silently score 0 — the IST operating day (CONTEXT §19) is what makes it count.
    await closeByVerification(t3, new Date('2026-06-18T18:45:00Z'));
    // 01:30 IST on the 21st, so it IS in the window's last day — but t2 was only ever assigned on the
    // 19th, so it must not count on the 21st. This is `completed ⊆ assigned` doing its job, and it
    // still holds now that a resolved row stays in `assigned` on the day it *was* dispatched.
    await closeByVerification(t2, new Date('2026-06-20T20:00:00Z'));
    // #229 D6 — t4's device healed itself before any form was submitted. That is a real closure, but
    // not work this SE completed (CONTEXT §Auto-Recovery: "no SE effort is credited"), so it must stay
    // in `assigned` and score 0 in `completed`.
    await closeByAutoRecovery(t4, new Date('2026-06-21T05:00:00Z'));

    // The premise of the whole fix: every closure above went through the production writer, so every
    // one of those batch rows is retired. A fixture that failed to reach this state would prove nothing.
    const stillLive = await prisma.batchAssignmentTicket.findMany({
      where: { ticketId: { in: [t1, t2, t3, t4] }, removedAt: null },
      select: { ticketId: true },
    });
    expect(stillLive).toEqual([]);

    const view = await history.getWorkHistory(se, { now: NOW });

    expect(view.days.map((d) => d.date)).toEqual([
      '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20', '2026-06-21',
    ]);
    const byDate = new Map(view.days.map((d) => [d.date, d]));
    // Three dispatched, two finished that day — neither erased by having been finished.
    expect(byDate.get('2026-06-19')).toEqual({ date: '2026-06-19', assigned: 3, completed: 2 });
    // t5 (ZM-withdrawn) is excluded from assigned; t6 is assigned but never closed; t4 is assigned and
    // closed, but auto-recovered — so the day reads 2 assigned, 0 completed (#229 D6).
    expect(byDate.get('2026-06-21')).toEqual({ date: '2026-06-21', assigned: 2, completed: 0 });
    // Days with no schedule are present as zeroes, never gaps — the chart renders 7 bars regardless.
    expect(byDate.get('2026-06-20')).toEqual({ date: '2026-06-20', assigned: 0, completed: 0 });
    expect(byDate.get('2026-06-15')).toEqual({ date: '2026-06-15', assigned: 0, completed: 0 });
    // Every bar fits its track.
    for (const d of view.days) expect(d.completed).toBeLessThanOrEqual(d.assigned);
  });

  /**
   * #297 AC2 — the other half of the split. A row the nightly recycle expired (#242) and a row a ZM
   * deferred are both off the plan without the work having finished, so they count in neither series.
   * The resolved sibling on the same day proves the day is not simply reading empty.
   */
  it('a plan-expired or deferred row counts in neither series, beside a resolved one that counts in both', async () => {
    const [t7, t8, t9] = await Promise.all([makeTicket(), makeTicket(), makeTicket()]);
    await makeSchedule(se, '2026-06-17', '2026-06-17', [t7], [
      { ticketId: t8, reason: REMOVAL_REASONS.PLAN_EXPIRED },
      { ticketId: t9, reason: REMOVAL_REASONS.ZM_DEFERRED },
    ]);

    await closeByVerification(t7, new Date('2026-06-17T10:00:00Z')); // 15:30 IST on the 17th

    const view = await history.getWorkHistory(se, { now: NOW });
    expect(view.days.find((d) => d.date === '2026-06-17')).toEqual({
      date: '2026-06-17',
      assigned: 1,
      completed: 1,
    });
  });

  /**
   * #297 regression guard — misclassifying a reason flips the error direction (counting withdrawn work
   * as assigned inflates the denominator of an SE's productivity chart), so every member of the closed
   * vocabulary gets its bucket pinned **by name** rather than by a total. One IST day per case, on an
   * SE of its own, so a failure names the reason that moved.
   */
  it('pins every removal reason to a bucket: only concluded work survives removal', async () => {
    const bucketSe = await makeSe();
    // `null` = the pre-#241 shape, a removed row with no cause recorded; `live` = never removed at all.
    const cases: { label: string; reason: RemovalReason | null; live?: true }[] = [
      { label: 'live', reason: null, live: true },
      { label: 'no-reason', reason: null },
      ...ALL_REMOVAL_REASONS.map((reason) => ({ label: reason as string, reason })),
    ];
    // Days 06-05 forward, all inside a 31-day window ending at NOW and clear of the other specs' SEs.
    const dayOf = (i: number) => isoDay(new Date(day('2026-06-05').getTime() + i * DAY_MS));
    expect(dayOf(cases.length - 1) <= '2026-06-21').toBe(true);

    for (const [i, c] of cases.entries()) {
      const ticketId = await makeTicket();
      const d = dayOf(i);
      if (c.live) await makeSchedule(bucketSe, d, d, [ticketId]);
      else await makeSchedule(bucketSe, d, d, [], [{ ticketId, reason: c.reason }]);
    }

    const view = await history.getWorkHistory(bucketSe, { now: NOW, days: 31 });
    const byDate = new Map(view.days.map((d) => [d.date, d.assigned]));

    const actual = cases.map((c, i) => [c.label, byDate.get(dayOf(i))] as const);
    const expected = cases.map(
      (c, i) =>
        [c.label, c.live || (c.reason != null && CONCLUDED_REMOVAL_REASONS.includes(c.reason)) ? 1 : 0] as const,
    );
    expect(actual).toEqual(expected);

    // The allow-list itself, spelled out — so widening it is a deliberate edit to this line too.
    expect([...CONCLUDED_REMOVAL_REASONS].sort()).toEqual(
      [REMOVAL_REASONS.AUTO_RECOVERY, REMOVAL_REASONS.RESOLVED_AT_CLOSURE, REMOVAL_REASONS.TICKET_RESOLVED].sort(),
    );
    // Exhaustive: a reason added to the vocabulary without a bucket fails here, not in production.
    expect(cases.filter((c) => !c.live && c.reason != null).map((c) => c.reason)).toEqual([...ALL_REMOVAL_REASONS]);
  });

  it("scopes to the calling SE — another engineer's schedule never appears", async () => {
    const mine = await makeTicket();
    const theirs = await makeTicket();
    await makeSchedule(otherSe, '2026-06-16', '2026-06-16', [theirs]);
    await makeSchedule(se, '2026-06-16', '2026-06-16', [mine]);
    await closeByVerification(theirs, new Date('2026-06-16T09:00:00Z'), otherSe);

    const view = await history.getWorkHistory(se, { now: NOW });
    const sixteenth = view.days.find((d) => d.date === '2026-06-16')!;
    expect(sixteenth).toEqual({ date: '2026-06-16', assigned: 1, completed: 0 });
  });

  it('serves the SE surface over HTTP, honours ?days=, and bounds a junk value', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/me/work-history?days=3')
      .set('Authorization', `Bearer ${seToken()}`)
      .expect(200);
    expect(res.body.days).toHaveLength(3);

    const dflt = await request(app.getHttpServer())
      .get('/api/me/work-history')
      .set('Authorization', `Bearer ${seToken()}`)
      .expect(200);
    expect(dflt.body.days).toHaveLength(7);

    // A query value is an unvalidated string: neither garbage nor an absurd range may 500 or scan a
    // year of events behind an otherwise-fine screen.
    for (const q of ['days=banana', 'days=0', 'days=-4', 'days=100000']) {
      const bounded = await request(app.getHttpServer())
        .get(`/api/me/work-history?${q}`)
        .set('Authorization', `Bearer ${seToken()}`)
        .expect(200);
      expect(bounded.body.days.length).toBeGreaterThanOrEqual(1);
      expect(bounded.body.days.length).toBeLessThanOrEqual(31);
    }
  });

  it('is SE-only', async () => {
    const oh = tokens.signAccessToken({ user_id: se, role: 'OPS_HEAD', zone_id: Number(zoneId) });
    await request(app.getHttpServer())
      .get('/api/me/work-history')
      .set('Authorization', `Bearer ${oh}`)
      .expect(403);
  });
});
