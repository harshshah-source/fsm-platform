import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { REMOVAL_REASONS } from '../src/scheduling/removal-reason';
import { COUNTABLE_REMOVAL_REASONS } from '../src/ticketing/special-ticket.query';
import { RESOLVED_TICKET_STATUSES } from '../src/ticketing/resolved-ticket-status';
import { InstallLifecycleService } from '../src/ticketing/install-lifecycle.service';
import { TroubleshootSubmissionService } from '../src/ticketing/troubleshoot-submission.service';
import { VerificationService } from '../src/verification/verification.service';

/**
 * #178 — terminal ticket closure must end the assignment with it.
 *
 * **The defect.** No closure path clears a ticket's assignment or retires its live
 * `batch_assignment_tickets` row. #241 fixed the two *cancellation* paths (device departure, plant
 * deactivation) and #242 added a nightly straggler backstop at schedule closure, but the paths where
 * a ticket genuinely *finishes* — verification decided, warehouse receipt, install closed, marked
 * non-operational — still set a terminal status and touch neither the row nor `assignment_state`.
 *
 * **Why it is not cosmetic.** `committedDayLoad` (`recommender.service.ts:926-937`) counts live batch
 * rows on live schedules with **no ticket-status filter**, so a finished ticket burns one of the SE's
 * capacity slots until its schedule dies — and per #147 nothing used to close schedules. The SE reads
 * as loaded with work that is over, and the recommender under-fills them accordingly. The same rows
 * render as live stops on the SE's day plan, which filters `removed_at` only.
 *
 * Every test here drives a **real closure entry point** and then asks the questions the two damaged
 * consumers ask: is the row still live, and is the ticket still FORMALLY_ASSIGNED.
 */
const NS = Date.now();
const NOW = new Date('2026-06-24T09:00:00Z');

describe('#178 — terminal closure clears the assignment', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let ohToken: string;
  let wmToken: string;
  let installs: InstallLifecycleService;
  let snapshotRunId: bigint;
  let submit: TroubleshootSubmissionService;
  let verify: VerificationService;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const markingIds: string[] = [];

  /**
   * A ticket live on an SE's day plan: schedule → batch → live `batch_assignment_tickets` row.
   * `overrides` lets a family that closes a different kind of ticket (a RECOVERY awaiting warehouse
   * receipt, an INSTALL) reuse the whole plan-side setup rather than rebuilding it.
   */
  const makeAssignedTicket = async (
    overrides: { workType?: 'TROUBLESHOOT' | 'RECOVERY' | 'INSTALL'; status?: string; activatedAt?: Date } = {},
  ): Promise<{ ticketId: string; cycleId: string }> => {
    const deviceId = String(12_400_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 120 * 60_000),
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: overrides.workType ?? 'TROUBLESHOOT',
        status: (overrides.status ?? 'OPEN') as never,
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        assignmentState: 'FORMALLY_ASSIGNED',
        activatedAt: overrides.activatedAt ?? null,
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);

    // Find-or-create: `work_schedules_one_active_per_se_zone_day` allows one live schedule per SE per
    // zone per day, so successive fixtures share the plan rather than minting a second.
    const schedule =
      (await prisma.workSchedule.findFirst({ where: { seId: se, zoneId, status: 'ACTIVE' } })) ??
      (await prisma.workSchedule.create({
        data: { seId: se, zoneId, dateFrom: NOW, dateTo: NOW, status: 'ACTIVE', dispatchedAt: NOW },
      }));
    const batch =
      (await prisma.plantBatchAssignment.findFirst({
        where: { scheduleId: schedule.scheduleId, plantId, seId: se },
      })) ??
      (await prisma.plantBatchAssignment.create({
        data: { scheduleId: schedule.scheduleId, plantId, seId: se, status: 'AUTO_ASSIGNED', stopSequence: 1 },
      }));
    await prisma.batchAssignmentTicket.create({
      data: { batchId: batch.batchId, ticketId: ticket.ticketId, sortOrder: 1 },
    });
    return { ticketId: ticket.ticketId, cycleId: cycle.cycleId };
  };

  /** The day-plan predicate itself — every SE-facing read spreads `removedAt: null`. */
  const liveRowsFor = (ticketId: string) =>
    prisma.batchAssignmentTicket.findMany({ where: { ticketId, removedAt: null } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    installs = app.get(InstallLifecycleService);
    submit = app.get(TroubleshootSubmissionService);
    verify = app.get(VerificationService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-178-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-178-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-178-' + NS, zoneId } })).plantId;
    snapshotRunId = (await prisma.snapshotRun.create({ data: { status: 'SUCCESS', dataAsOf: NOW } })).runId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@c178.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });

    // Operations Head: global scope, so no zone clamp stands between the test and the closure path.
    // Minted here rather than borrowed from the shared auth fixture because the non-op path stores the
    // confirming manager's id on the marking, and that column expects a real user.
    const ohTag = randomUUID().slice(0, 8);
    const oh = await prisma.user.create({
      data: { name: 'OH ' + ohTag, role: 'OPERATIONS_HEAD', phone: 'ph-' + ohTag, email: `${ohTag}@c178.test`, zoneId },
    });
    userIds.push(oh.userId);
    ohToken = tokens.signAccessToken({ user_id: oh.userId, role: 'OPERATIONS_HEAD', zone_id: null });

    // Warehouse Manager: the only role the receipt route accepts.
    const wmTag = randomUUID().slice(0, 8);
    const wm = await prisma.user.create({
      data: { name: 'WM ' + wmTag, role: 'WAREHOUSE_MANAGER', phone: 'ph-' + wmTag, email: `${wmTag}@c178.test`, zoneId },
    });
    userIds.push(wm.userId);
    wmToken = tokens.signAccessToken({ user_id: wm.userId, role: 'WAREHOUSE_MANAGER', zone_id: Number(zoneId) });
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
    await prisma.nonOperationalMarking.deleteMany({ where: { markingId: { in: markingIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.rawDeviceSnapshot.deleteMany({ where: { runId: snapshotRunId } });
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
   * Marking a ticket auto-recovered is the shortest closure path in the product: one route, one
   * transaction, a terminal status. Before #178 it left the batch row live, so the SE kept a stop for
   * a device the manager had just declared recovered — and the recommender kept the capacity slot
   * spent on it.
   */
  it('mark-auto-recovery takes the ticket off the day plan and clears FORMALLY_ASSIGNED', async () => {
    const { ticketId } = await makeAssignedTicket();
    expect(await liveRowsFor(ticketId)).toHaveLength(1); // live on the plan before the close

    await request(app.getHttpServer())
      .post(`/api/verification/${ticketId}/mark-auto-recovery`)
      .set('Authorization', `Bearer ${ohToken}`)
      .expect(201);

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('CLOSED_AUTO_RECOVERY');

    // The two damaged consumers, asked directly.
    expect(await liveRowsFor(ticketId)).toHaveLength(0); // day plan + committedDayLoad
    expect(ticket.assignmentState).toBe('UNASSIGNED'); // FORMALLY_ASSIGNED ⇒ live work

    // History is stamped, never deleted.
    const row = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { ticketId } });
    expect(row.removedAt).not.toBeNull();
  });

  /**
   * A device confirmed non-operational auto-closes its in-flight tickets (CONTEXT §14). The dual
   * confirmation is what triggers it, so the fixture pre-sets the customer leg and the manager's
   * confirm completes the pair. The device is off the road; the SE must not still be routed to it.
   */
  it('non-operational confirmation takes its auto-closed tickets off the day plan', async () => {
    const { ticketId } = await makeAssignedTicket();
    const ticketBefore = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    const marking = await prisma.nonOperationalMarking.create({
      data: {
        deviceId: ticketBefore.deviceId,
        state: 'AWAITING_ZM_CONFIRMATION',
        customerConfirmedAt: NOW, // customer leg already in; the manager's confirm completes the pair
      },
    });
    markingIds.push(marking.markingId);
    expect(await liveRowsFor(ticketId)).toHaveLength(1);

    await request(app.getHttpServer())
      .post(`/api/non-op/${marking.markingId}/confirm`)
      .set('Authorization', `Bearer ${ohToken}`)
      .expect(200);

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('CLOSED_NON_OPERATIONAL');
    expect(await liveRowsFor(ticketId)).toHaveLength(0);
    expect(ticket.assignmentState).toBe('UNASSIGNED');
  });
  /**
   * A Recovery ticket auto-closes the moment the warehouse confirms receipt — the device is physically
   * back in the warehouse, so there is nothing left for the SE to collect. Its batch row outliving that
   * is the same phantom stop as every other family here.
   */
  it('warehouse receipt closes the recovery ticket and retires its assignment', async () => {
    const { ticketId } = await makeAssignedTicket({ workType: 'RECOVERY', status: 'COLLECTED' });
    expect(await liveRowsFor(ticketId)).toHaveLength(1);

    await request(app.getHttpServer())
      .post(`/api/recovery/${ticketId}/receipt`)
      .set('Authorization', `Bearer ${wmToken}`)
      .expect(200);

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('CLOSED');
    expect(await liveRowsFor(ticketId)).toHaveLength(0);
    expect(ticket.assignmentState).toBe('UNASSIGNED');
  });
  /**
   * Manual closure is the exception path a manager takes when the normal flow cannot finish — and it
   * shares `closeWith` with the failed-recovery close, so retiring the assignment there covers both
   * of the recovery family's manager-driven terminal states.
   */
  it('manual close of a recovery ticket retires its assignment', async () => {
    const { ticketId } = await makeAssignedTicket({ workType: 'RECOVERY', status: 'COLLECTED' });
    expect(await liveRowsFor(ticketId)).toHaveLength(1);

    await request(app.getHttpServer())
      .post(`/api/recovery/${ticketId}/manual-close`)
      .set('Authorization', `Bearer ${ohToken}`)
      .send({ reason: 'device written off after site survey' })
      .expect(200);

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('CLOSED');
    expect(await liveRowsFor(ticketId)).toHaveLength(0);
    expect(ticket.assignmentState).toBe('UNASSIGNED');
  });
  /**
   * The install sweep closes an ACTIVATED install on the device's first post-fitment ping. It is cron
   * driven with no HTTP route, so the sweep method is the seam. `ticketIds` scopes it to this
   * fixture — the sweep is otherwise fleet-wide.
   */
  it('install verification closes the ticket and retires its assignment', async () => {
    const activatedAt = new Date(NOW.getTime() - 60 * 60_000);
    const { ticketId } = await makeAssignedTicket({ workType: 'INSTALL', status: 'ACTIVATED', activatedAt });
    const ticketBefore = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    // A ping after fitment is what verifies the install — no geofence applies (LLD open item #5).
    await prisma.rawDeviceSnapshot.create({
      data: { runId: snapshotRunId, deviceId: ticketBefore.deviceId, gpsDatetime: new Date(activatedAt.getTime() + 30 * 60_000), lat: 0, lon: 0 },
    });
    expect(await liveRowsFor(ticketId)).toHaveLength(1);

    const res = await installs.runInstallVerification(NOW, { ticketIds: [ticketId] });
    expect(res.verified).toBe(1);

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('CLOSED');
    expect(await liveRowsFor(ticketId)).toHaveLength(0);
    expect(ticket.assignmentState).toBe('UNASSIGNED');
  });
  /**
   * The verification worker is the normal end of a troubleshoot: the SE submits, the device pings near
   * the submission anchor through the window, the ticket closes. This is the highest-volume closure in
   * the product and therefore the largest source of the 351 phantom rows the issue measured.
   *
   * Note the intermediate state is deliberately left alone — a VERIFICATION_PENDING ticket is *not*
   * terminal, its assignment is still real, and the row stays live until the worker decides.
   */
  it('verification closing a troubleshoot retires its assignment', async () => {
    const { ticketId } = await makeAssignedTicket();
    const ticketBefore = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    const anchor = { lat: 12.9716, lon: 77.5946 };

    await submit.submit({
      ticketId,
      seId: se,
      clientSubmissionId: randomUUID(),
      rootCauseCategory: 'POWER_ISSUE',
      seGps: anchor,
      presenceSource: 'FORM_GPS',
      actor: { userId: se, role: 'SERVICE_ENGINEER', actedAsRole: null },
      now: NOW,
    });
    // Submission alone must NOT end the assignment — the ticket is pending, not finished.
    expect(await liveRowsFor(ticketId)).toHaveLength(1);

    for (const m of [1, 20, 45, 65]) {
      await prisma.rawDeviceSnapshot.create({
        data: {
          runId: snapshotRunId,
          deviceId: ticketBefore.deviceId,
          gpsDatetime: new Date(NOW.getTime() + m * 60_000),
          lat: 12.9721,
          lon: 77.5946,
        },
      });
    }

    const res = await verify.runVerification(new Date(NOW.getTime() + 70 * 60_000), { ticketIds: [ticketId] });
    expect(res.closed).toBe(1);

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('CLOSED');
    expect(await liveRowsFor(ticketId)).toHaveLength(0);
    expect(ticket.assignmentState).toBe('UNASSIGNED');
  });
  /**
   * The invariant the six tests above each prove one path of, asserted once over everything this spec
   * closed: **FORMALLY_ASSIGNED ⇒ the ticket is live** (#178 AC-2), and no resolved ticket keeps a live
   * batch row.
   *
   * Deliberately scoped to this spec's own tickets rather than the whole table. The suite shares one
   * database, and other specs legitimately construct resolved-but-assigned rows as fixtures — a
   * table-wide assertion here would fail on their data, not on a defect. Catching a *seventh* closure
   * path nobody has noticed therefore needs a new test alongside the others, not a wider query.
   */
  it('AC-2: no ticket closed by this spec is still FORMALLY_ASSIGNED or still on a plan', async () => {
    const closed = await prisma.ticket.findMany({
      where: { ticketId: { in: ticketIds }, status: { in: [...RESOLVED_TICKET_STATUSES] } },
      select: { ticketId: true, status: true, assignmentState: true },
    });
    // Guard against the assertion passing because nothing was closed at all.
    expect(closed.length).toBeGreaterThanOrEqual(6);
    expect(closed.filter((t) => t.assignmentState !== 'UNASSIGNED')).toEqual([]);

    const stillLive = await prisma.batchAssignmentTicket.findMany({
      where: { ticketId: { in: closed.map((t) => t.ticketId) }, removedAt: null },
      select: { ticketId: true },
    });
    expect(stillLive).toEqual([]);
  });

  /**
   * History is stamped, never deleted, and every removed row carries a cause — #241 table-wide
   * invariant, which this slice must not breach. TICKET_RESOLVED is the reason the closure paths
   * write, and it is excluded from #244 countable set by construction (that set is an allow-list).
   */
  it('closure stamps TICKET_RESOLVED with a null actor and keeps the row', async () => {
    const rows = await prisma.batchAssignmentTicket.findMany({
      where: { ticketId: { in: ticketIds }, removalReason: REMOVAL_REASONS.TICKET_RESOLVED },
      select: { removedBy: true, removedAt: true },
    });
    expect(rows.length).toBeGreaterThanOrEqual(6);
    // Somebody closed the ticket; nobody withdrew the assignment. Who closed it is on the ticket trail.
    expect(rows.every((r) => r.removedBy === null && r.removedAt !== null)).toBe(true);
    expect(COUNTABLE_REMOVAL_REASONS).not.toContain(REMOVAL_REASONS.TICKET_RESOLVED);
  });
});
