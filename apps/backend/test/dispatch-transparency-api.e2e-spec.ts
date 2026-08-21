import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';

/**
 * Batch-Assignment transparency read surface — `/api/dispatch-runs/*`. Role matrix: managers
 * (ZM/CSM/OH) read; a ZONAL_MANAGER is clamped to their own zone at every level (list totals, run
 * detail zone cards, zone detail, batch detail, per-ticket trace); SERVICE_ENGINEER is 403;
 * unauthenticated is 401.
 *
 * Seeding drives the REAL write path (runForZone + dispatchForZone with a runId) in two zones:
 * the ZM's zone 1 (one dispatched ticket + one NO_COVERAGE unassignable) and a foreign zone
 * (one dispatched ticket) the ZM must never see.
 */
const NS = Date.now();
const NOW = new Date('2026-07-15T05:00:00Z');
const DAY = new Date('2026-07-15T00:00:00Z');
const ZM_ZONE = 1n; // zm.north@fsm.test carries zone_id 1 in its claims

describe('/api/dispatch-runs (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zoneOther: bigint;
  let plantZm: bigint;
  let plantZmUncovered: bigint;
  let plantOther: bigint;
  let companyId: bigint;
  let seZm: string;
  let seOther: string;
  let runId: bigint;
  let zmBatchId: bigint;
  let otherBatchId: bigint;
  let tZmAssigned: string;
  let tZmUnassignable: string;
  let tOther: string;
  let ohActorName: string;
  let vehicleNo: string;
  let transporterName: string;
  let vehicleId: bigint;
  let transporterId: bigint;
  const companyName = 'Co-dt-api-' + NS;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  let zmZoneCreatedHere = false;

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const makeSe = async (tag: string, zoneId: bigint, capacity: number): Promise<string> => {
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@dt-api.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: capacity },
    });
    return u.userId;
  };

  const makeTicket = async (plantId: bigint, zoneCompanyId: bigint): Promise<string> => {
    const deviceId = String(9_550_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 90 * 60_000),
        plantId,
        companyId: zoneCompanyId,
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
        companyId: zoneCompanyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
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

    await purgeOrphans(prisma);

    // The ZM's zone (id 1) must exist as a row; create it if this DB doesn't have it yet.
    const zm = await prisma.zone.findUnique({ where: { zoneId: ZM_ZONE } });
    if (!zm) {
      await prisma.$executeRaw`INSERT INTO zones (zone_id, name, created_at, updated_at) VALUES (1, ${'Z1-dt-api-' + NS}, now(), now())`;
      zmZoneCreatedHere = true;
    }
    zoneOther = (await prisma.zone.create({ data: { name: 'Z-dt-api-other-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-dt-api-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantZm = (await prisma.plant.create({ data: { name: 'P-dt-zm-' + NS, zoneId: ZM_ZONE } })).plantId;
    plantZmUncovered = (await prisma.plant.create({ data: { name: 'P-dt-zm-un-' + NS, zoneId: ZM_ZONE } })).plantId;
    plantOther = (await prisma.plant.create({ data: { name: 'P-dt-other-' + NS, zoneId: zoneOther } })).plantId;

    const tag = randomUUID().slice(0, 8);
    seZm = await makeSe('zm-' + tag, ZM_ZONE, 25);
    seOther = await makeSe('ot-' + tag, zoneOther, 10);
    await prisma.seCoverage.create({ data: { seId: seZm, plantId: plantZm, coverageType: 'DEDICATED' } });
    await prisma.seCoverage.create({ data: { seId: seOther, plantId: plantOther, coverageType: 'DEDICATED' } });

    tZmAssigned = await makeTicket(plantZm, companyId);
    tZmUnassignable = await makeTicket(plantZmUncovered, companyId);
    tOther = await makeTicket(plantOther, companyId);

    // Vehicle + transporter on the assigned ticket, so the enrichment fields (vehicleNo /
    // transporterName) have a value to resolve (Issue 125).
    const transporter = await prisma.transporter.create({ data: { name: 'TR-dt-api-' + NS, companyId } });
    transporterId = transporter.transporterId;
    transporterName = transporter.name;
    const vehicle = await prisma.vehicle.create({
      data: { vehicleNo: 'VN-dt-' + NS, plantId: plantZm, companyId, transporterId },
    });
    vehicleId = vehicle.vehicleId;
    vehicleNo = vehicle.vehicleNo;
    await prisma.ticket.update({ where: { ticketId: tZmAssigned }, data: { vehicleId } });

    // Real write path, scoped to our two zones (a full runForActiveZones would dispatch every zone in
    // this shared DB). The ledger/zone-row writes were pinned in dispatch-transparency.e2e-spec.
    const recommender = app.get(RecommenderService);
    const dispatch = app.get(BatchAssignmentService);
    // Login users (ops.head@fsm.test) live in the in-memory auth store, not the `users` table
    // (#91 InMemoryUserStore), so the actor needs a real row to resolve a name from.
    const ohActor = await prisma.user.create({
      data: { name: 'OH Actor ' + NS, role: 'OPERATIONS_HEAD', phone: 'ph-oh-' + NS, email: `oh-actor-${NS}@dt-api.test` },
    });
    userIds.push(ohActor.userId);
    ohActorName = ohActor.name;
    const run = await prisma.dispatchRun.create({
      data: {
        trigger: 'MANUAL',
        actorUserId: ohActor.userId,
        actorRole: 'OPERATIONS_HEAD',
        startedAt: NOW,
        configSnapshot: {
          priorityRules: [],
          settings: {},
          capacity: { [seZm]: { dailyCapacity: 25, isActive: true }, [seOther]: { dailyCapacity: 10, isActive: true } },
          scheduler: { businessSweepsEnabled: false, dispatchCron: '0 5 * * *' },
        },
      },
    });
    runId = run.runId;
    for (const zoneId of [ZM_ZONE, zoneOther]) {
      const zoneStart = new Date();
      const rec = await recommender.runForZone(zoneId, { now: NOW, runId });
      const out = await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId });
      await prisma.dispatchRunZone.create({
        data: {
          runId,
          zoneId,
          // #259 — this fixture hand-writes what a completed zone looks like; a completed claim is DONE.
          status: 'DONE',
          // #252 — written by #238/#242 and, until #259 landed the projection, read by nobody. Pinned
          // here so the assertion below proves the whole path, not just the query object.
          withheldBelowThreshold: 4,
          bucketlessDropped: 12,
          mode: rec.mode,
          weightSetRef: rec.weightSetRef,
          ticketsConsidered: rec.ticketsConsidered,
          recommended: rec.recommended,
          unassignable: rec.unassignable,
          unassignableReasons: rec.unassignableReasons as object,
          schedules: out.schedules,
          batches: out.batches,
          ticketsDispatched: out.tickets,
          startedAt: zoneStart,
          finishedAt: new Date(),
        },
      });
    }
    await prisma.dispatchRun.update({
      where: { runId },
      data: { finishedAt: new Date(), status: 'SUCCESS', zones: 2, schedules: 2, batches: 2, ticketsDispatched: 2, recommended: 2, unassignable: 1 },
    });

    zmBatchId = (
      await prisma.plantBatchAssignment.findFirstOrThrow({ where: { plantId: plantZm, seId: seZm } })
    ).batchId;
    otherBatchId = (
      await prisma.plantBatchAssignment.findFirstOrThrow({ where: { plantId: plantOther, seId: seOther } })
    ).batchId;
  });

  afterAll(async () => {
    const schedules = await prisma.workSchedule.findMany({ where: { runId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { runId } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } }); // traces cascade
    await prisma.dispatchRun.deleteMany({ where: { runId } }); // zone rows cascade
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.vehicle.deleteMany({ where: { vehicleId } }); // after tickets (FK ticket.vehicle_id)
    await prisma.transporter.deleteMany({ where: { transporterId } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantZm, plantZmUncovered, plantOther] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: zoneOther } });
    if (zmZoneCreatedHere) await prisma.zone.deleteMany({ where: { zoneId: ZM_ZONE } });
    await app.close();
  });

  it('OH sees the run in the list with cross-zone totals', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      // #180 R1.3 — the list is capped at limit=30 (DispatchTransparencyQueryService default); this
      // fixture run's frozen-past startedAt sorts behind any real-clock run created since, so an
      // unbounded request can page it out once 30 newer rows accumulate. Bound it explicitly instead
      // of relying on staying in the newest page.
      .get('/api/dispatch-runs?limit=200')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const row = res.body.find((r: any) => r.runId === runId.toString());
    expect(row).toMatchObject({
      trigger: 'MANUAL',
      status: 'SUCCESS',
      zones: 2,
      schedules: 2,
      ticketsDispatched: 2,
      recommended: 2,
      unassignable: 1,
      errorCount: 0,
    });
    expect(row.startedAt).toBeDefined();
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    // Gap A: MANUAL run shows who triggered it (name + role), not just a UUID.
    expect(row).toMatchObject({ actorRole: 'OPERATIONS_HEAD', actorName: ohActorName });
  });

  it('ZM list totals are clamped to their zone slice', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      // #180 R1.3 — same unbounded-list risk as the OH case above.
      .get('/api/dispatch-runs?limit=200')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const row = res.body.find((r: any) => r.runId === runId.toString());
    expect(row).toMatchObject({ zones: 1, schedules: 1, ticketsDispatched: 1, unassignable: 1 });
  });

  it('OH run detail: config snapshot + both zone cards with reason buckets', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/dispatch-runs/${runId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.configSnapshot.capacity[seZm]).toEqual({ dailyCapacity: 25, isActive: true });
    expect(res.body).toMatchObject({ actorRole: 'OPERATIONS_HEAD', actorName: ohActorName });
    expect(res.body.zones).toHaveLength(2);
    const zmCard = res.body.zones.find((z: any) => z.zoneId === ZM_ZONE.toString());
    expect(zmCard).toMatchObject({ mode: 'DEFICIT', recommended: 1, unassignable: 1, ticketsDispatched: 1 });
    expect(zmCard.unassignableReasons.NO_COVERAGE).toBe(1);
  });

  it('ZM run detail shows only their zone card', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/dispatch-runs/${runId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.zones).toHaveLength(1);
    expect(res.body.zones[0].zoneId).toBe(ZM_ZONE.toString());
  });

  it('zone detail: batches with SE, capacity used, plant + Day Plan link; unassignable with reason', async () => {
    const token = await login('csm@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/dispatch-runs/${runId}/zones/${ZM_ZONE}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.batches).toHaveLength(1);
    expect(res.body.batches[0]).toMatchObject({
      batchId: zmBatchId.toString(),
      seId: seZm,
      plantName: 'P-dt-zm-' + NS,
      ticketCount: 1,
      capacityUsed: { used: 1, cap: 25 },
    });
    expect(res.body.batches[0].scheduleId).toBeDefined();
    // Enrichment (Issue 125): company beside plant on both batch and unassignable rows.
    expect(res.body.batches[0].companyName).toBe(companyName);
    expect(res.body.unassignable).toHaveLength(1);
    expect(res.body.unassignable[0]).toMatchObject({
      ticketId: tZmUnassignable,
      poolEmptyReason: 'NO_COVERAGE',
      companyName,
    });
    // #252 (landed with #259) — the three "the engine did not decide" populations reach the client.
    // `recommended + unassignable` is not the whole funnel and the page can no longer imply it is.
    expect(res.body.zone).toMatchObject({
      outcome: 'DONE',
      contendedWithRunId: null,
      withheldBelowThreshold: 4,
      bucketlessDropped: 12,
      // NULL survives as NULL: a run that never measured this must not report 0, which would claim a
      // measurement nobody took.
      componentBlockedWithheld: null,
    });
    // Change-request 2026-07: per-plant fleet stats for every dispatched plant, keyed by plantId.
    const dispatchedPlantId = res.body.batches[0].plantId;
    expect(res.body.plantStats[dispatchedPlantId]).toMatchObject({
      totalDevices: expect.any(Number),
      inactiveDevices: expect.any(Number),
      assignedDevices: expect.any(Number),
      unassignedDevices: expect.any(Number),
    });
  });

  /**
   * #178 — the per-plant fleet stats count tickets by `assignment_state` and must not count ones whose
   * ticket is over. Closure now clears `assignment_state`, so without a status filter here a closed
   * ticket would simply move from the assigned column to the unassigned one and still be reported as
   * outstanding work at the plant. It belongs in neither.
   */
  it('#178: a closed ticket at a dispatched plant counts as neither assigned nor unassigned', async () => {
    const token = await login('csm@fsm.test');
    const detail = () =>
      request(app.getHttpServer())
        .get(`/api/dispatch-runs/${runId}/zones/${ZM_ZONE}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

    const before = (await detail()).body;
    const dispatchedPlantId = before.batches[0].plantId;
    const statsBefore = before.plantStats[dispatchedPlantId];

    // A finished ticket at that same plant. FORMALLY_ASSIGNED is left on deliberately: it is exactly
    // the shape #178's backfill has yet to reach, and the read must be honest about it regardless.
    const closedTicketId = await makeTicket(BigInt(dispatchedPlantId), companyId);
    await prisma.ticket.update({
      where: { ticketId: closedTicketId },
      data: { status: 'CLOSED', assignmentState: 'FORMALLY_ASSIGNED' },
    });

    const statsAfter = (await detail()).body.plantStats[dispatchedPlantId];
    expect(statsAfter.assignedDevices).toBe(statsBefore.assignedDevices);
    expect(statsAfter.unassignedDevices).toBe(statsBefore.unassignedDevices);
  });

  it('ZM foreign zone detail is 403 (global ZoneScopeGuard, not the service clamp)', async () => {
    // The `:zoneId` route param trips the platform-wide ZoneScopeGuard (#99) before the controller
    // runs — the standard cross-zone response. (Batch/trace routes have no :zoneId param, so they
    // fall through to the service clamp and 404 instead — see those tests below.)
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/dispatch-runs/${runId}/zones/${zoneOther}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(res.body.message).toBe('ZONE_SCOPE_VIOLATION');
  });

  it('batch detail: assignment rows with rank, score, status', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/batches/${zmBatchId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.seId).toBe(seZm);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      ticketId: tZmAssigned,
      plantId: plantZm.toString(),
      seId: seZm,
      rank: 1,
      recStatus: 'DISPATCHED',
      ticketStatus: 'OPEN',
      hasTrace: true,
    });
    expect(typeof res.body.rows[0].score).toBe('number');
    expect(res.body.rows[0].deviceId).toBeDefined();
    // Gap C: degeneracy is on the row so the table can hide scores without N trace fetches.
    expect(res.body.rows[0].scoreDegenerate).toBe(true);
    // Enrichment (Issue 125): company/vehicle/transporter context on the assignment row.
    expect(res.body.rows[0]).toMatchObject({ companyName, vehicleNo, transporterName });
  });

  it('ZM cannot read a foreign zone batch', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .get(`/api/batches/${otherBatchId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('batch detail resolves a batch whose schedule has NO dispatch run (pre-ledger / ZM_MANUAL)', async () => {
    // `work_schedules.run_id` is nullable, and on real data most live batches have none — they predate
    // the ledger or came from the manual path. A batch is addressed by its own id, so it must resolve
    // regardless, reporting `runId: null` rather than 404ing out of the drill-down.
    await prisma.workSchedule.updateMany({ where: { runId }, data: { runId: null } });
    try {
      const token = await login('ops.head@fsm.test');
      const res = await request(app.getHttpServer())
        .get(`/api/batches/${zmBatchId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.batchId).toBe(zmBatchId.toString());
      expect(res.body.runId).toBeNull();
      expect(res.body.seId).toBe(seZm);
      // The tickets still render; only the run-keyed trace is unavailable.
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0].hasTrace).toBe(false);
    } finally {
      await prisma.workSchedule.updateMany({ where: { runId: null, seId: { in: [seZm, seOther] } }, data: { runId } });
    }
  });

  it('a ZM is still zone-clamped on a run-less batch', async () => {
    // The zone clamp must hang off the schedule's zone, not the run — losing it on the run-less path
    // would open foreign-zone batches to a ZM.
    await prisma.workSchedule.updateMany({ where: { runId }, data: { runId: null } });
    try {
      const token = await login('zm.north@fsm.test');
      await request(app.getHttpServer())
        .get(`/api/batches/${otherBatchId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/api/batches/${zmBatchId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    } finally {
      await prisma.workSchedule.updateMany({ where: { runId: null, seId: { in: [seZm, seOther] } }, data: { runId } });
    }
  });

  it('per-ticket trace: precedence-led decision record, ZM-readable in own zone', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/dispatch-runs/${runId}/tickets/${tZmAssigned}/trace`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.trace.chosen).toMatchObject({ seId: seZm, coverageType: 'DEDICATED', precedenceRank: 1 });
    expect(res.body.trace.scoreDegenerate).toBe(true);
    expect(res.body.scoreBreakdown).toBeDefined();
    // Gap D: seId -> name map so the trace reads in human terms, not UUIDs.
    expect(res.body.seNames[seZm]).toMatch(/^SE zm-/);
    // Enrichment (Issue 125): full ticket-identity strip for "why this SE" without navigating away.
    expect(res.body.identity).toMatchObject({
      deviceId: expect.any(String),
      plantName: 'P-dt-zm-' + NS,
      companyName,
      vehicleNo,
      transporterName,
    });

    await request(app.getHttpServer())
      .get(`/api/dispatch-runs/${runId}/tickets/${tOther}/trace`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('role matrix: SE is 403, unauthenticated is 401', async () => {
    const seToken = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/dispatch-runs').set('Authorization', `Bearer ${seToken}`).expect(403);
    await request(app.getHttpServer()).get('/api/dispatch-runs').expect(401);
  });
});

/**
 * Self-healing pre-clean: purge any orphaned artifacts this spec left behind if a previous run
 * aborted mid-`beforeAll` (e.g. before its `afterAll` could scope its deletes). Pattern-matched on
 * this spec's own naming (`P-dt-*`, `*@dt-api.test`, `Z-dt-api-*`, `Co-dt-api-*`) so it never touches
 * other suites' data or the shared ZM zone (id 1, named `Z1-dt-api-*` — deliberately NOT purged).
 * FK-safe order: decision traces (RESTRICT on ticket_id + run_id) before tickets/runs; run_id links
 * on recommendations/work_schedules are SET NULL, dispatch_run_zones CASCADE with the run.
 */
async function purgeOrphans(prisma: PrismaService): Promise<void> {
  const plants = await prisma.plant.findMany({ where: { name: { startsWith: 'P-dt-' } }, select: { plantId: true } });
  const users = await prisma.user.findMany({ where: { email: { endsWith: '@dt-api.test' } }, select: { userId: true } });
  const plantIds = plants.map((p) => p.plantId);
  const userIds = users.map((u) => u.userId);
  if (plantIds.length === 0 && userIds.length === 0) return;

  const tickets = plantIds.length
    ? await prisma.ticket.findMany({ where: { plantId: { in: plantIds } }, select: { ticketId: true, deviceId: true } })
    : [];
  const ticketIds = tickets.map((t) => t.ticketId);
  const deviceIds = [...new Set(tickets.map((t) => t.deviceId).filter((d): d is string => d != null))];
  const runs = userIds.length
    ? await prisma.dispatchRun.findMany({ where: { actorUserId: { in: userIds } }, select: { runId: true } })
    : [];
  const runIds = runs.map((r) => r.runId);

  await prisma.dispatchDecisionTrace.deleteMany({ where: { OR: [{ ticketId: { in: ticketIds } }, { runId: { in: runIds } }] } });
  await prisma.batchAssignmentTicket.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await prisma.plantBatchAssignment.deleteMany({ where: { plantId: { in: plantIds } } });
  await prisma.workSchedule.deleteMany({ where: { OR: [{ runId: { in: runIds } }, { seId: { in: userIds } }] } });
  await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await prisma.dispatchRun.deleteMany({ where: { runId: { in: runIds } } }); // zone rows cascade
  await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
  // Vehicles/transporters reference plants/company — clear them (after tickets) before plant/company.
  await prisma.vehicle.deleteMany({ where: { vehicleNo: { startsWith: 'VN-dt-' } } });
  await prisma.transporter.deleteMany({ where: { name: { startsWith: 'TR-dt-api-' } } });
  await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
  await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
  await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
  await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
  await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.plant.deleteMany({ where: { plantId: { in: plantIds } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: 'Co-dt-api-' } } });
  await prisma.zone.deleteMany({ where: { name: { startsWith: 'Z-dt-api-other-' } } });
}
