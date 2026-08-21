import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { AuditService } from '../src/audit/audit.service';
import { istDate } from '../src/common/ist-day';
import { PrismaService } from '../src/prisma/prisma.service';
import { IntradayInsertionService } from '../src/intraday/intraday-insertion.service';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * #265 — lost-race hygiene: every legitimate concurrency race on the manual paths ends with a correct
 * winner, a clean explained 4xx for the loser, and **untouched attribution**. Decision #258 Parts 5–6
 * (G4, G7).
 *
 * The manual paths were written as `read → check in JS → write by primary key`, which under READ
 * COMMITTED means two writers both pass the check and the second either crashes into a partial unique
 * (an unhandled P2002 → 500) or silently clobbers the first writer's row. Neither is acceptable on a
 * surface #272's console is about to make it *easy* to hit: the whole point of an M→N assign console
 * is several managers moving work at once.
 *
 * **Two facts about this codebase shape every test below, and both were measured rather than assumed:**
 *
 * 1. A P2002 raised inside a Prisma interactive transaction **aborts that transaction** — Postgres
 *    answers every subsequent statement with *"current transaction is aborted, commands ignored until
 *    end of transaction block"*. So a recovery cannot catch-and-continue inside the `withAudit` block;
 *    it has to let the whole thing roll back and decide outside. That rollback is also what keeps the
 *    audit row honest, since `withAudit` writes it inside the same transaction.
 * 2. `meta.target` — the usual way to tell *which* constraint blew — is **absent** here. The driver
 *    adapter reports it at `meta.driverAdapterError.cause.constraint.fields`, with the index name only
 *    in the raw message. `modelName` is the exact discriminator instead: neither
 *    `batch_assignment_tickets` nor `work_schedules` carries any unique but its own partial index.
 */
const NS = Date.now();

describe('#265 — lost-race hygiene', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let override: OverrideService;
  let audit: AuditService;
  let intraday: IntradayInsertionService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let otherPlantId: bigint;
  let seA: string;
  let seB: string;
  let zmId: string;

  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const NOW = new Date();
  const TODAY = istDate(NOW);

  const scope = { role: 'ZONAL_MANAGER', zoneId: 0 } as { role: string; zoneId: number };
  const actor = () => ({ userId: zmId, role: 'ZONAL_MANAGER', actedAsRole: null });

  const makeSe = async (): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@race.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 50 },
    });
    return u.userId;
  };

  const makeTicket = async (plant: bigint = plantId): Promise<string> => {
    const deviceId = String(12_770_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId: plant,
        companyId,
        companyTier: 'GOLD',
        assignmentState: 'UNASSIGNED',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  /** Live batch rows for a ticket, table-wide — the partial unique's whole population. */
  const liveRows = (ticketId: string) =>
    prisma.batchAssignmentTicket.findMany({ where: { ticketId, removedAt: null } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    override = app.get(OverrideService);
    audit = app.get(AuditService);
    intraday = app.get(IntradayInsertionService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-race-' + NS } })).zoneId;
    scope.zoneId = Number(zoneId);
    companyId = (
      await prisma.company.create({ data: { name: 'Co-race-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-race-' + NS, zoneId } })).plantId;
    otherPlantId = (await prisma.plant.create({ data: { name: 'P-race2-' + NS, zoneId } })).plantId;

    seA = await makeSe();
    seB = await makeSe();

    const zmTag = randomUUID().slice(0, 8);
    const zm = await prisma.user.create({
      data: { name: 'ZM ' + zmTag, role: 'ZONAL_MANAGER', phone: 'ph-' + zmTag, email: `${zmTag}@race.test`, zoneId },
    });
    userIds.push(zm.userId);
    zmId = zm.userId;
  });

  afterAll(async () => {
    const scheds = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: scheds.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.intradayInsertion.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantId, otherPlantId] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  /**
   * Park the next `withAudit` call between its caller's pre-read and its write, run `whileParked`
   * there, then let it through. The gap this opens is the exact one every unguarded terminal stamp in
   * this service races through; see slice 3 for why the concurrency harness cannot reach it.
   */
  const raceInsideAudit = async <T>(start: () => Promise<T>, whileParked: () => Promise<void>): Promise<T> => {
    let entered!: () => void;
    const hasEntered = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const real = audit.withAudit.bind(audit);
    const spy = vi.spyOn(audit, 'withAudit').mockImplementationOnce(async (entry, work) => {
      entered();
      await released;
      return real(entry, work);
    });
    const running = start();
    await hasEntered;
    await whileParked();
    release();
    try {
      return await running;
    } finally {
      spy.mockRestore();
    }
  };

  /** The 04:00 closure recycle's guarded write, verbatim from `schedule-closure-scheduler.service.ts`. */
  const closureStamps = async (id: bigint, at: Date) => {
    const { count } = await prisma.batchAssignmentTicket.updateMany({
      where: { id, removedAt: null },
      data: { removedAt: at, removedBy: null, removalReason: 'RESOLVED_AT_CLOSURE' },
    });
    expect(count).toBe(1); // the closure genuinely won; the rest is about the loser
  };

  /** Attribution survived verbatim, the loser was told, and nothing claims the action happened. */
  const expectLoserWasClean = async (id: bigint, at: Date, outcome: { result: string }, batchId: bigint, action: string) => {
    const after = await prisma.batchAssignmentTicket.findUniqueOrThrow({ where: { id } });
    expect(after.removedBy).toBeNull();
    expect(after.removalReason).toBe('RESOLVED_AT_CLOSURE');
    expect(after.removedAt?.getTime()).toBe(at.getTime());
    expect(outcome.result).toBe('NOT_FOUND');
    expect(
      await prisma.auditLog.count({
        where: { actorId: zmId, entityId: String(batchId), action: { contains: action } },
      }),
    ).toBe(0);
  };

  /**
   * Slice 1 — **AC-1.** Two managers assign the same ticket; one wins, the other is told so.
   *
   * `assignTicket`'s `ALREADY_ASSIGNED` guard reads `tickets.assignment_state` **outside** its
   * transaction (`override.service.ts:344`), so both callers pass it and the loser's
   * `batchAssignmentTicket.create` lands on `batch_assignment_tickets_one_active_per_ticket`. The
   * P2002 was never caught: it propagated out of the service as an unhandled 500, on a code path two
   * controllers map carefully to a 409 for exactly this condition.
   *
   * The race is staged **deterministically** rather than by hoping two promises interleave: the
   * winner's live batch row is written first while the ticket is left `UNASSIGNED`, which is precisely
   * the state the loser's already-completed pre-check observed. That is not a contrived state either —
   * it is the same `FORMALLY_ASSIGNED`-vs-live-row inconsistency class #243 exists to clean up. A true
   * concurrent pair follows in the next test, where it is the *schedule* unique under contention.
   */
  it('answers the loser of an assign race with ALREADY_ASSIGNED, not a 500', async () => {
    const ticketId = await makeTicket();

    // The winner: a real assignment through the real primitive.
    const won = await override.assignTicket(ticketId, seA, scope, actor(), NOW);
    expect(won.result).toBe('OK');

    // Rewind only the field the loser's pre-check reads — their check ran before the winner committed.
    await prisma.ticket.update({ where: { ticketId }, data: { assignmentState: 'UNASSIGNED' } });

    const lost = await override.assignTicket(ticketId, seB, scope, actor(), NOW);
    expect(lost.result).toBe('ALREADY_ASSIGNED');

    // The constraint's whole population, asserted table-wide: the loser must not have left a row.
    expect(await liveRows(ticketId)).toHaveLength(1);
  });
  /**
   * Slice 2 — **AC-2.** Two managers assign to the same engineer, who has no schedule yet. Both
   * succeed, and exactly one schedule exists.
   *
   * `ensureSchedule` is a find-then-create (`override.service.ts:585-596`) with no guard, so both
   * callers find nothing and both create. `work_schedules_one_active_per_se_zone_day` is a partial
   * unique on `(se_id, zone_id, date_from) WHERE status = 'ACTIVE'`, so the loser 500s — and unlike
   * the assign race above, the loser here has done **nothing wrong**: their ticket is a different
   * ticket, at a different plant, and there is no reason for it not to land. The caller's intent is
   * "get me this engineer's live schedule for the day", and a schedule now exists. Failing them is a
   * pure artefact of the implementation.
   *
   * This one is left as a **real** concurrent pair, but note honestly what it does and does not
   * establish: the two transactions were measured **not** to interleave reliably here, so this pins
   * the required *outcome* rather than proving the race was hit. The test below it stages the same
   * `ensureSchedule` defect deterministically, and that is the one whose red was observed.
   *
   * The double assertion matters. "Both OK" alone would pass if the fix created two schedules; "one
   * schedule" alone would pass if the fix rejected the loser. Together they pin the only correct
   * outcome: one schedule, shared.
   */
  it('lets both writers through a schedule race, onto one schedule', async () => {
    const se = await makeSe();
    const t1 = await makeTicket(plantId);
    const t2 = await makeTicket(otherPlantId);

    const [r1, r2] = await Promise.all([
      override.assignTicket(t1, se, scope, actor(), NOW),
      override.assignTicket(t2, se, scope, actor(), NOW),
    ]);

    expect([r1.result, r2.result]).toEqual(['OK', 'OK']);

    const schedules = await prisma.workSchedule.findMany({
      where: { seId: se, zoneId, dateFrom: TODAY },
    });
    expect(schedules).toHaveLength(1);

    // Both tickets landed, on that one schedule — the assignment actually happened for both.
    expect(await liveRows(t1)).toHaveLength(1);
    expect(await liveRows(t2)).toHaveLength(1);
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: schedules[0].scheduleId },
    });
    expect(batches.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * Slice 2b — the same `ensureSchedule` defect, reachable **without any concurrency at all**, and
   * this is the one that reds on demand.
   *
   * `work_schedules_one_active_per_se_zone_day` is a partial unique on
   * `(se_id, zone_id, date_from) WHERE status = 'ACTIVE'` — it does **not** include `date_to`.
   * `batch-assignment.service.ts:128` finds a schedule by exactly those three columns, matching the
   * index. `ensureSchedule` matches on `date_to` as well (`override.service.ts:592`). Two call sites,
   * two different answers to "which row is this engineer's schedule for this day", and the database
   * agreeing with only one of them.
   *
   * The consequence needs no second writer: give the engineer any live schedule whose `date_to`
   * differs — a multi-day plan, which `swapSe` and `moveTickets` propagate by handing the *source*
   * batch's range to `ensureSchedule`, or a null one, which the column allows — and every manual
   * assign to them for that day finds nothing, creates, and dies on the index. A 500, deterministically,
   * with no race involved.
   *
   * The fix is the same one the race needs, which is why it lives here: the re-find has to agree with
   * the constraint. The assertion is that the assign lands **on the existing schedule** rather than
   * creating a second one — the index permits no second, so attaching is the only correct outcome.
   */
  it('assigns onto an existing live schedule whose date range differs, instead of 500ing', async () => {
    const se = await makeSe();
    const tomorrow = new Date(TODAY.getTime() + 86_400_000);
    // A multi-day plan: the shape `swapSe`/`moveTickets` propagate, and the shape the index covers
    // while `ensureSchedule`'s find does not.
    const existing = await prisma.workSchedule.create({
      data: { seId: se, zoneId, dateFrom: TODAY, dateTo: tomorrow, status: 'ACTIVE', source: 'ZM_MANUAL', dispatchedAt: NOW },
    });

    const ticketId = await makeTicket();
    const out = await override.assignTicket(ticketId, se, scope, actor(), NOW);

    expect(out.result).toBe('OK');
    // Attached to the schedule that already existed — not a second row the constraint forbids.
    expect((out as { scheduleId: string }).scheduleId).toBe(String(existing.scheduleId));
    expect(await prisma.workSchedule.count({ where: { seId: se, zoneId, dateFrom: TODAY } })).toBe(1);
    expect(await liveRows(ticketId)).toHaveLength(1);
  });

  /**
   * Slice 3 — **AC-3.** The first writer's attribution survives verbatim, the loser gets a clean
   * outcome, and **no audit row claims an action that did not happen**.
   *
   * `removeTicket` reads the live row outside its transaction and then updates **by primary key with
   * no `removedAt: null` re-assertion** (`override.service.ts:196-206`). The 04:00 closure recycle
   * guards its own writes and says exactly why
   * (`schedule-closure-scheduler.service.ts:255-265`): *"keying only on `id` would then overwrite
   * their actor and reason with a system stamp — and #244 reads that reason as a predicate, so the
   * mistake would be an operational reclassification rather than a visible one."* The guard is on the
   * side that loses. The side that wins has none.
   *
   * **How the window is opened, deterministically.** `Promise.all` does not work here — the harness
   * `test/support/concurrency.ts` exists precisely to say so, and its own spec demonstrates that an
   * unbarriered race "passes without ever having tried the case it claims to cover" (which the
   * schedule test above ran into). `override()` takes no injection point, but `AuditService` is an
   * injected collaborator and `removeTicket` does its pre-read *before* calling `withAudit` — so
   * gating the first `withAudit` call is exactly the gap between the read and the write. No production
   * seam is added for the test's benefit.
   *
   * Three assertions, and each fails differently before the fix: the closure's attribution is
   * overwritten, the caller is told OK for work it did not do, and an audit row is filed for it.
   */
  it('leaves the first writer’s attribution alone, answers the loser cleanly, and files no audit row', async () => {
    const ticketId = await makeTicket();
    const assigned = await override.assignTicket(ticketId, seA, scope, actor(), NOW);
    expect(assigned.result).toBe('OK');
    const batchId = BigInt((assigned as { batchId: string }).batchId);
    const [row] = await liveRows(ticketId);

    // Park the remove inside `withAudit` — after its pre-read, before its write.
    let entered!: () => void;
    const hasEntered = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const realWithAudit = audit.withAudit.bind(audit);
    const spy = vi.spyOn(audit, 'withAudit').mockImplementationOnce(async (entry, work) => {
      entered();
      await released;
      return realWithAudit(entry, work);
    });

    const removing = override.override(
      batchId,
      { action: 'REMOVE_TICKET', ticketId, reasonCode: 'ZM_CHANGED_PLAN' },
      scope,
      actor(),
      NOW,
    );
    await hasEntered;

    // The 04:00 closure sweep commits first — its exact guarded write, verbatim from the scheduler.
    const closureAt = new Date(NOW.getTime() + 1000);
    const { count } = await prisma.batchAssignmentTicket.updateMany({
      where: { id: row.id, removedAt: null },
      data: { removedAt: closureAt, removedBy: null, removalReason: 'RESOLVED_AT_CLOSURE' },
    });
    expect(count).toBe(1); // the closure genuinely won; the rest of the test is about the loser

    release();
    const outcome = await removing;
    spy.mockRestore();

    // 1. The winner's attribution is untouched — actor, reason and timestamp all still theirs.
    const after = await prisma.batchAssignmentTicket.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.removedBy).toBeNull();
    expect(after.removalReason).toBe('RESOLVED_AT_CLOSURE');
    expect(after.removedAt?.getTime()).toBe(closureAt.getTime());

    // 2. The loser is told, cleanly. The row it asked to withdraw is already gone — which is the same
    //    answer it would have received had its read run a moment later.
    expect(outcome.result).toBe('NOT_FOUND');

    // 3. And nothing in the trail claims a withdrawal happened.
    const claims = await prisma.auditLog.count({
      where: { actorId: zmId, entityId: String(batchId), action: { contains: 'REMOVE_TICKET' } },
    });
    expect(claims).toBe(0);
  });

  /**
   * Slice 4 — **AC-3, the other two writers.** `deferTicket` (`override.service.ts:245`) and the
   * removal leg of `moveTickets` (`:567`) carry the identical unguarded stamp, and the issue lists all
   * three together for a reason: fixing only the one with a test would leave two paths that still
   * silently overwrite a system attribution, on the same table, through the same window.
   *
   * `moveTickets` is the one that matters most. Its stamp sits **in a loop** over the moved rows, so a
   * lost race on any single row must fail the whole move — a REASSIGN that moved three of four tickets
   * and reported success would be worse than one that refused. The throw rolls the transaction back
   * whole, which is what makes that automatic.
   */
  it.each([
    ['DEFER_TICKET', 'a defer'],
    ['REASSIGN', 'a reassign'],
  ])('leaves the first writer alone when %s loses the race', async (action) => {
    const ticketId = await makeTicket();
    const assigned = await override.assignTicket(ticketId, seA, scope, actor(), NOW);
    const batchId = BigInt((assigned as { batchId: string }).batchId);
    const [row] = await liveRows(ticketId);
    const closureAt = new Date(NOW.getTime() + 1000);

    const cmd =
      action === 'DEFER_TICKET'
        ? { action: 'DEFER_TICKET' as const, ticketId, deferredToDate: '2026-12-01', reasonCode: 'ZM_HOLD' }
        : { action: 'REASSIGN' as const, ticketId, newSeId: seB, reasonCode: 'ZM_REBALANCE' };

    const outcome = await raceInsideAudit(
      () => override.override(batchId, cmd, scope, actor(), NOW),
      () => closureStamps(row.id, closureAt),
    );

    await expectLoserWasClean(row.id, closureAt, outcome, batchId, action);
    // ...and for the move specifically: no destination row was opened for a move that did not happen.
    if (action === 'REASSIGN') expect(await liveRows(ticketId)).toHaveLength(0);
  });

  /**
   * Slice 5 — **AC-4.** A ticket deferred between the offer and the ZM's manual assign says so.
   *
   * `manualAssign` collapses every non-OK, non-ALREADY_ASSIGNED answer from `assignTicket` into
   * `NOT_FOUND` (`intraday-insertion.service.ts:319`), which the controller renders as a 404
   * `INSERTION_OR_SE_NOT_FOUND`. So #249's `CONFLICT_DEFERRED` — a real, resolvable, *actionable*
   * condition, with a confirm flow already built for it — reaches the ZM as "that doesn't exist".
   * They retry, get the same 404, and the retry chain burns against a hold nothing on screen names.
   *
   * The distinction is the whole point of #249: a deferral may be **overridden, never bypassed**. A ZM
   * told "not found" cannot override anything; a ZM told the ticket is held until Friday can decide.
   */
  it('tells the ZM a manual assign was refused by a deferral, not that nothing was found', async () => {
    const ticketId = await makeTicket();
    const heldUntil = new Date(TODAY.getTime() + 5 * 86_400_000);
    await prisma.ticket.update({ where: { ticketId }, data: { deferredUntil: heldUntil } });

    const insertion = await prisma.intradayInsertion.create({
      data: {
        ticketId,
        zoneId,
        status: 'ESCALATION_REQUIRED',
        slaBucket: 'CRITICAL',
        offeredSeId: seB,
        offeredAt: NOW,
        acceptanceDeadline: new Date(NOW.getTime() + 15 * 60_000),
      },
    });

    const out = await intraday.manualAssign(insertion.insertionId, seA, actor(), scope, NOW);

    expect(out.result).toBe('CONFLICT_DEFERRED');
    // The date travels with the refusal, or the ZM still cannot tell what they would be overriding.
    expect((out as { deferredUntil: string }).deferredUntil).toBe(heldUntil.toISOString());
    // ...and nothing was assigned on the way to saying so.
    expect(await liveRows(ticketId)).toHaveLength(0);
  });

  /**
   * Slice 6 — **item 5's sweep, and it found one.** `flagOverridden` resurrects a closed day plan.
   *
   * Every override action ends by calling it, and it writes
   * `workSchedule.update({ where: { scheduleId }, data: { status: 'OVERRIDDEN' } })` — by primary key,
   * with no liveness guard. `OVERRIDDEN` is a **live** status (#153: `LIVE_SCHEDULE_STATUSES`), while
   * `COMPLETED` and `PARTIAL` are terminal, and `schedule-status.ts` says exactly what is at stake:
   * *"widening past those would resurrect finished work onto today's plan."* That is what this write
   * does, one row at a time, whenever an override lands on a plan the 04:00 closure has already shut.
   *
   * It needs no race to reproduce — a manager acting on a stale screen is enough — which is why it is
   * staged directly. The guard is the same one the rest of this issue applies: put the state in the
   * WHERE and let the database decline.
   *
   * **Narrowly fixed on purpose.** The removal itself still happens: the ticket returns to the pool,
   * which is what the manager asked for and is harmless on a finished plan. Whether an override should
   * be *refused* outright on a terminal schedule is a lifecycle question that belongs to #271
   * (fold/resume at submission, terminal at verification), not a change to smuggle in here.
   */
  it('does not resurrect a closed day plan when an override lands on it', async () => {
    const ticketId = await makeTicket();
    const assigned = await override.assignTicket(ticketId, seA, scope, actor(), NOW);
    const batchId = BigInt((assigned as { batchId: string }).batchId);
    const scheduleId = BigInt((assigned as { scheduleId: string }).scheduleId);

    // The 04:00 closure shuts the plan.
    await prisma.workSchedule.update({ where: { scheduleId }, data: { status: 'COMPLETED' } });

    const outcome = await override.override(
      batchId,
      { action: 'REMOVE_TICKET', ticketId, reasonCode: 'ZM_CHANGED_PLAN' },
      scope,
      actor(),
      NOW,
    );
    expect(outcome.result).toBe('OK');

    // The plan stays closed. Nothing about withdrawing a ticket from a finished day makes it unfinished.
    const after = await prisma.workSchedule.findUniqueOrThrow({ where: { scheduleId } });
    expect(after.status).toBe('COMPLETED');
    expect(after.lastOverriddenBy).toBeNull();
    // ...and the withdrawal the manager actually asked for did happen.
    expect(await liveRows(ticketId)).toHaveLength(0);
  });

  /**
   * Slice 7 — **item 4's other half.** An SE accepting a ticket that went on hold mid-flight escalates
   * it, instead of burning the retry chain against a hold nobody can see.
   *
   * `accept` treats every non-OK answer from `assignTicket` the same way: release the claim back to
   * `PENDING_ACCEPTANCE` so the timeout sweep re-offers it (`intraday-insertion.service.ts:198-205`).
   * For "the ticket was assigned out from under us" that is right. For `CONFLICT_DEFERRED` it is
   * useless in a specific and costly way: **no Service Engineer can clear a deferral.** The next SE
   * hits the identical refusal, and the one after that, until the retry chain is exhausted and the
   * ticket escalates anyway — hours later, with a trail that records several SEs declining nothing.
   *
   * A hold only a manager can override should reach a manager immediately. That path now exists and
   * works: slice 5 gave the escalation queue's manual assign the `CONFLICT_DEFERRED` answer and the
   * confirm-with-reason flow to resolve it, so escalating here hands the ZM something they can act on
   * rather than another dead end.
   *
   * Asserted on the persisted row rather than the return value, because the re-offer is the harm and
   * `AcceptOutcome` needs no new member to express it.
   */
  it('escalates an accept refused by a deferral instead of re-offering it to the next engineer', async () => {
    const ticketId = await makeTicket();
    await prisma.ticket.update({
      where: { ticketId },
      data: { deferredUntil: new Date(TODAY.getTime() + 5 * 86_400_000) },
    });

    const insertion = await prisma.intradayInsertion.create({
      data: {
        ticketId,
        zoneId,
        status: 'PENDING_ACCEPTANCE',
        slaBucket: 'CRITICAL',
        offeredSeId: seA,
        offeredAt: NOW,
        acceptanceDeadline: new Date(NOW.getTime() + 15 * 60_000),
        retryCount: 0,
      },
    });

    await intraday.accept(insertion.insertionId, seA, NOW);

    const after = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId: insertion.insertionId } });
    expect(after.status).toBe('ESCALATION_REQUIRED');
    // Not re-offered, and no retry spent on an engineer who could never have succeeded.
    expect(after.retryCount).toBe(0);
    expect(await liveRows(ticketId)).toHaveLength(0);
  });

});
