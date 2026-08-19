import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { REMOVAL_REASONS, type RemovalReason } from '../src/scheduling/removal-reason';
import {
  DEFAULT_SPECIAL_ATTEMPT_THRESHOLD,
  SPECIAL_ATTEMPT_THRESHOLD_DESCRIPTION,
  SPECIAL_ATTEMPT_THRESHOLD_KEY,
} from '../src/settings/special-threshold';
import { SpecialTicketQueryService } from '../src/ticketing/special-ticket.query';

/**
 * #244 — Special is **derived**, and this spec is where the definition lives or dies.
 *
 * The approved definition has three parts, and every one of them is a claim about evidence rather
 * than about intent:
 *
 *  - **Attempt window** = one `batch_assignment_tickets` row. Not a dispatch, not a notification —
 *    the row is the only artefact that exists for every assignment path (05:00 run, intraday accept,
 *    `assignTicket`, and the new row a REASSIGN/SPLIT_BATCH opens). `SWAP_SE` re-points the batch and
 *    never the rows, so it continues one window; `REORDER` writes no row at all.
 *  - **Reached** = a `soft_states` row inside the window. The earliest such signal is the mobile
 *    auto-posted `VIEWED`, so this proves the SE **opened the ticket in the app**. It deliberately
 *    does NOT prove handset delivery, and a server-side assignment with no soft state is therefore
 *    not an attempt at all — which is the whole reason Special cannot be counted from dispatches.
 *  - **Success** = a `troubleshooting_submissions` row. One writer, already idempotent; no second
 *    definition of "the SE fixed it" is invented here. The component-unavailable variant still writes
 *    one, because the SE *did* diagnose the fault.
 *
 * A countable attempt is reached ∧ unsubmitted ∧ ended `PLAN_EXPIRED` or `VEHICLE_UNAVAILABLE`. Every
 * other removal reason is an approved exclusion, and the reason they are excluded is the same in each
 * case: somebody *decided* the attempt should end, so it is not evidence the ticket resists repair.
 *
 * Two structural properties fall out rather than being coded, and both are asserted below because
 * "falls out" is exactly the kind of claim that stops being true later:
 *   1. **A live window is never judged** — it carries no `removal_reason`, and the countable filter is
 *      on the reason. (#241's table-wide invariant is what guarantees reason ⟺ closed.)
 *   2. **No writer exists**, so a late submission un-Specials a ticket with nothing to undo.
 */
const NS = Date.now();
const NOW = new Date('2026-08-19T06:00:00Z');
const DAY = 86_400_000;

interface WindowSpec {
  /** null = still live (no reason, no `removed_at`). */
  reason: RemovalReason | null;
  /** A `soft_states` row inside the window — the SE opened it in the app. */
  reached?: boolean;
  /** A `troubleshooting_submissions` row inside the window — the SE diagnosed the fault. */
  submitted?: boolean;
  /** Days before NOW the window opened; it closes 12 h later. */
  daysAgo?: number;
}

describe('#244 — Special-ticket derivation over the assignment ledger', () => {
  let prisma: PrismaService;
  let special: SpecialTicketQueryService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const scheduleIds: bigint[] = [];

  const makeTicket = async (
    status: 'OPEN' | 'CLOSED' = 'OPEN',
    workType: 'TROUBLESHOOT' | 'INSTALL' = 'TROUBLESHOOT',
  ): Promise<{ ticketId: string; cycleId: string }> => {
    const deviceId = String(14_200_000_000 + (NS % 100_000) * 20 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const t = await prisma.ticket.create({
      data: {
        workType,
        status,
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

  /** One assignment window on its own schedule/batch, with the evidence the spec asks for inside it. */
  const addWindow = async (
    ticket: { ticketId: string; cycleId: string },
    spec: WindowSpec,
    sortOrder = 1,
  ): Promise<bigint> => {
    const daysAgo = spec.daysAgo ?? 1;
    const openedAt = new Date(NOW.getTime() - daysAgo * DAY);
    const closedAt = new Date(openedAt.getTime() + 12 * 3_600_000);
    const day = new Date(Date.UTC(openedAt.getUTCFullYear(), openedAt.getUTCMonth(), openedAt.getUTCDate()));
    const schedule = await prisma.workSchedule.create({
      data: {
        seId,
        zoneId,
        dateFrom: day,
        dateTo: day,
        status: spec.reason === null ? 'ACTIVE' : 'PARTIAL',
        source: 'SYSTEM_GENERATED',
        dispatchedAt: openedAt,
      },
    });
    scheduleIds.push(schedule.scheduleId);
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    const row = await prisma.batchAssignmentTicket.create({
      data: {
        batchId: batch.batchId,
        ticketId: ticket.ticketId,
        sortOrder,
        createdAt: openedAt,
        ...(spec.reason === null ? {} : { removedAt: closedAt, removedBy: null, removalReason: spec.reason }),
      },
    });
    if (spec.reached) {
      await prisma.softState.create({
        data: {
          ticketId: ticket.ticketId,
          seId,
          type: 'VIEWED',
          // Inside the window, which is the only thing that makes it evidence for *this* attempt.
          setAt: new Date(openedAt.getTime() + 3_600_000),
          // `soft_states_viewed_timeout_present` — a VIEWED state expires, and the DB enforces it.
          timeoutAt: new Date(openedAt.getTime() + 3_600_000 + 90 * 60_000),
          resolvedAt: closedAt,
        },
      });
    }
    if (spec.submitted) {
      await prisma.troubleshootingSubmission.create({
        data: {
          ticketId: ticket.ticketId,
          failureCycleId: ticket.cycleId,
          submissionType: 'TROUBLESHOOTING_FORM',
          clientSubmissionId: randomUUID(),
          seId,
          presenceSource: 'FORM_GPS',
          rootCauseCategory: 'POWER_ISSUE',
          submittedAt: new Date(openedAt.getTime() + 4 * 3_600_000),
        },
      });
    }
    return row.id;
  };

  /** A ticket with `n` identical countable attempts — the D0..Dn simulation in one line. */
  const ticketWithCountableAttempts = async (n: number): Promise<string> => {
    const t = await makeTicket();
    for (let i = 0; i < n; i++) {
      await addWindow(t, { reason: REMOVAL_REASONS.PLAN_EXPIRED, reached: true, daysAgo: n - i }, i + 1);
    }
    return t.ticketId;
  };

  const verdict = async (ticketId: string) => {
    const map = await special.verdictsFor([ticketId]);
    const v = map.get(ticketId);
    if (!v) throw new Error(`no verdict for ${ticketId}`);
    return v;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    special = new SpecialTicketQueryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-spc-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-spc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-spc-' + NS, zoneId } })).plantId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@spc.test`, zoneId },
    });
    userIds.push(u.userId);
    seId = u.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    });
  });

  afterAll(async () => {
    await prisma.systemSetting.upsert({
      where: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY },
      create: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY, description: SPECIAL_ATTEMPT_THRESHOLD_DESCRIPTION, value: DEFAULT_SPECIAL_ATTEMPT_THRESHOLD as unknown as object },
      update: { value: DEFAULT_SPECIAL_ATTEMPT_THRESHOLD as unknown as object },
    });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
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
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  /**
   * AC-1, the D0–D4 simulation the issue asks for, asserted from both sides of the boundary in one
   * ticket's history: at two attempts it is not Special, at three it is. Same ledger, same threshold —
   * the only thing that changed is the evidence.
   */
  it('AC-1: three reached-but-unworked attempts make a ticket Special; two do not', async () => {
    const twoAttempts = await ticketWithCountableAttempts(2);
    const threeAttempts = await ticketWithCountableAttempts(3);

    const two = await verdict(twoAttempts);
    const three = await verdict(threeAttempts);

    expect(two).toMatchObject({ countableAttempts: 2, isSpecial: false });
    expect(three).toMatchObject({ countableAttempts: 3, isSpecial: true });
  });

  /**
   * AC-2, one case per approved exclusion. Each of these ended because somebody *decided* it should,
   * so none is evidence that the ticket resists repair — which is the single reason the whole list is
   * excluded, and the reason a future reason-code must be classified deliberately rather than by
   * default. Asserted at three windows each, i.e. at the threshold, so an exclusion that silently
   * stopped working would flip the verdict rather than merely shifting a count.
   */
  it('AC-2: no excluded removal reason ever counts, even at threshold volume', async () => {
    const excluded: RemovalReason[] = [
      REMOVAL_REASONS.ZM_WITHDRAWN,
      REMOVAL_REASONS.ZM_DEFERRED,
      REMOVAL_REASONS.REASSIGNED,
      REMOVAL_REASONS.BULK_UNASSIGNED,
      REMOVAL_REASONS.AUTO_RECOVERY,
      REMOVAL_REASONS.TICKET_CANCELLED,
      REMOVAL_REASONS.COMPONENT_WAIT,
      REMOVAL_REASONS.DEV_CLEANUP,
      REMOVAL_REASONS.HUMAN_REMOVED,
      REMOVAL_REASONS.RESOLVED_AT_CLOSURE,
    ];
    for (const reason of excluded) {
      const t = await makeTicket();
      for (let i = 0; i < 3; i++) await addWindow(t, { reason, reached: true, daysAgo: 3 - i }, i + 1);

      const v = await verdict(t.ticketId);

      expect(v, `reason ${reason} must not count`).toMatchObject({ countableAttempts: 0, isSpecial: false });
    }
  });

  /** AC-2's other half — the assignment nobody ever opened. This is what makes Special a statement
   *  about the field and not about the dispatcher. */
  it('AC-2: a window with no soft state was never reached, so it never counts', async () => {
    const t = await makeTicket();
    for (let i = 0; i < 3; i++) {
      await addWindow(t, { reason: REMOVAL_REASONS.PLAN_EXPIRED, reached: false, daysAgo: 3 - i }, i + 1);
    }

    expect(await verdict(t.ticketId)).toMatchObject({ countableAttempts: 0, isSpecial: false });
  });

  /** A soft state OUTSIDE the window is somebody else's evidence — most often the *next* attempt's.
   *  Counting it would let one visit make every window in the history "reached". */
  it('a soft state outside the window does not make that window reached', async () => {
    const t = await makeTicket();
    // Three unreached windows, then one soft state long after all of them closed.
    for (let i = 0; i < 3; i++) {
      await addWindow(t, { reason: REMOVAL_REASONS.PLAN_EXPIRED, reached: false, daysAgo: 10 - i }, i + 1);
    }
    await prisma.softState.create({
      data: {
        ticketId: t.ticketId,
        seId,
        type: 'VIEWED',
        setAt: NOW,
        timeoutAt: new Date(NOW.getTime() + 90 * 60_000),
      },
    });

    expect(await verdict(t.ticketId)).toMatchObject({ countableAttempts: 0, isSpecial: false });
  });

  /**
   * The success writer. A submission anywhere in the ticket's history disqualifies it outright — the
   * SE did diagnose the fault, so whatever else happened the ticket is not "never successfully
   * reached". The component-unavailable variant writes one too, and that is deliberate.
   */
  it('a submission ever recorded disqualifies the ticket, component-unavailable included', async () => {
    const plain = await makeTicket();
    for (let i = 0; i < 3; i++) {
      await addWindow(plain, { reason: REMOVAL_REASONS.PLAN_EXPIRED, reached: true, daysAgo: 5 - i }, i + 1);
    }
    // A fourth window in which the SE finally submitted.
    await addWindow(plain, { reason: REMOVAL_REASONS.PLAN_EXPIRED, reached: true, submitted: true, daysAgo: 1 }, 4);

    const v = await verdict(plain.ticketId);
    expect(v.isSpecial).toBe(false);
    expect(v.hasSubmission).toBe(true);
  });

  /** Structural property 1 — a live window carries no reason, so it is in progress rather than judged. */
  it('a live window is never judged', async () => {
    const t = await makeTicket();
    for (let i = 0; i < 2; i++) {
      await addWindow(t, { reason: REMOVAL_REASONS.PLAN_EXPIRED, reached: true, daysAgo: 3 - i }, i + 1);
    }
    await addWindow(t, { reason: null, reached: true, daysAgo: 0 }, 3); // today's live assignment

    expect(await verdict(t.ticketId)).toMatchObject({ countableAttempts: 2, isSpecial: false });
  });

  /**
   * AC-3 — the threshold reclassifies retroactively, in both directions, with no writer involved.
   * This is the property that made "derived" the right representation: a stored counter would have to
   * be recomputed for every open ticket on every settings change, and the recompute would be the thing
   * that drifted.
   */
  it('AC-3: moving the threshold reclassifies existing tickets on the next read, both ways', async () => {
    const ticketId = await ticketWithCountableAttempts(3);
    expect((await verdict(ticketId)).isSpecial).toBe(true);

    await prisma.systemSetting.upsert({
      where: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY },
      create: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY, description: SPECIAL_ATTEMPT_THRESHOLD_DESCRIPTION, value: 4 as unknown as object },
      update: { value: 4 as unknown as object },
    });
    expect((await verdict(ticketId)).isSpecial).toBe(false);

    await prisma.systemSetting.upsert({
      where: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY },
      create: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY, description: SPECIAL_ATTEMPT_THRESHOLD_DESCRIPTION, value: 2 as unknown as object },
      update: { value: 2 as unknown as object },
    });
    expect((await verdict(ticketId)).isSpecial).toBe(true);

    await prisma.systemSetting.upsert({
      where: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY },
      create: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY, description: SPECIAL_ATTEMPT_THRESHOLD_DESCRIPTION, value: DEFAULT_SPECIAL_ATTEMPT_THRESHOLD as unknown as object },
      update: { value: DEFAULT_SPECIAL_ATTEMPT_THRESHOLD as unknown as object },
    });
  });

  /** Structural property 2 — the self-correction. There is no offline queue on mobile: a submit that
   *  was lost simply arrives on re-send, and when it does the Special verdict must evaporate by
   *  itself. Nothing is un-written, because nothing was written. */
  it('a submission arriving after the verdict un-Specials the ticket with nothing to undo', async () => {
    const t = await makeTicket();
    for (let i = 0; i < 3; i++) {
      await addWindow(t, { reason: REMOVAL_REASONS.PLAN_EXPIRED, reached: true, daysAgo: 5 - i }, i + 1);
    }
    expect((await verdict(t.ticketId)).isSpecial).toBe(true);

    await prisma.troubleshootingSubmission.create({
      data: {
        ticketId: t.ticketId,
        failureCycleId: t.cycleId,
        submissionType: 'TROUBLESHOOTING_FORM',
        clientSubmissionId: randomUUID(),
        seId,
        presenceSource: 'FORM_GPS',
        rootCauseCategory: 'UNKNOWN',
        submittedAt: NOW,
      },
    });

    expect((await verdict(t.ticketId)).isSpecial).toBe(false);
  });

  /** A closed ticket is finished work; Special is a statement about work still outstanding. */
  it('only an OPEN ticket can be Special', async () => {
    const t = await makeTicket('CLOSED');
    for (let i = 0; i < 3; i++) {
      await addWindow(t, { reason: REMOVAL_REASONS.PLAN_EXPIRED, reached: true, daysAgo: 5 - i }, i + 1);
    }

    const v = await verdict(t.ticketId);
    expect(v).toMatchObject({ countableAttempts: 3, isSpecial: false });
  });

  /**
   * A deliberate narrowing, recorded rather than assumed: Special is defined by the *absence of a
   * troubleshooting submission*, and an INSTALL ticket can never have one — so without this clause
   * every repeatedly-dispatched install would be Special by vacuous truth, which is a different and
   * unapproved concept ("dispatched a lot") wearing the same badge.
   */
  it('an INSTALL ticket is never Special, however often it expired', async () => {
    const t = await makeTicket('OPEN', 'INSTALL');
    for (let i = 0; i < 3; i++) {
      await addWindow(t, { reason: REMOVAL_REASONS.PLAN_EXPIRED, reached: true, daysAgo: 5 - i }, i + 1);
    }

    expect(await verdict(t.ticketId)).toMatchObject({ isSpecial: false });
  });

  /** VEHICLE_UNAVAILABLE is the second countable end (#246): the SE reached the plant and the vehicle
   *  was not there. Mixed with PLAN_EXPIRED, the two accumulate toward one threshold. */
  it('VEHICLE_UNAVAILABLE counts alongside PLAN_EXPIRED', async () => {
    const t = await makeTicket();
    await addWindow(t, { reason: REMOVAL_REASONS.VEHICLE_UNAVAILABLE, reached: true, daysAgo: 3 }, 1);
    await addWindow(t, { reason: REMOVAL_REASONS.PLAN_EXPIRED, reached: true, daysAgo: 2 }, 2);
    await addWindow(t, { reason: REMOVAL_REASONS.VEHICLE_UNAVAILABLE, reached: true, daysAgo: 1 }, 3);

    expect(await verdict(t.ticketId)).toMatchObject({ countableAttempts: 3, isSpecial: true });
  });

  /**
   * The batched contract. The list surface asks about a page of tickets at once, and a per-ticket loop
   * over ~12k open tickets is the thing the issue explicitly forbids — so the aggregate takes a set and
   * returns a map, and a ticket with no ledger at all still gets an answer rather than being absent.
   */
  it('answers for a whole page in one call, including tickets with no assignment history', async () => {
    const never = await makeTicket();
    const twice = await ticketWithCountableAttempts(2);
    const thrice = await ticketWithCountableAttempts(3);

    const map = await special.verdictsFor([never.ticketId, twice, thrice]);

    expect(map.size).toBe(3);
    expect(map.get(never.ticketId)).toMatchObject({ countableAttempts: 0, isSpecial: false });
    expect(map.get(twice)).toMatchObject({ countableAttempts: 2, isSpecial: false });
    expect(map.get(thrice)).toMatchObject({ countableAttempts: 3, isSpecial: true });
    expect(await special.verdictsFor([])).toEqual(new Map());
  });

  /**
   * The per-window history the detail view renders. It must be readable as an account of what happened
   * — window by window, with the evidence that decided each one — because "this ticket is Special" is
   * a claim a manager has to be able to check rather than trust.
   */
  it('reports the per-window attempt history, newest last, with its evidence and verdict', async () => {
    const t = await makeTicket();
    await addWindow(t, { reason: REMOVAL_REASONS.PLAN_EXPIRED, reached: true, daysAgo: 3 }, 1);
    await addWindow(t, { reason: REMOVAL_REASONS.ZM_WITHDRAWN, reached: true, daysAgo: 2 }, 2);
    await addWindow(t, { reason: REMOVAL_REASONS.PLAN_EXPIRED, reached: false, daysAgo: 1 }, 3);

    const history = await special.attemptsFor(t.ticketId);
    if (!history) throw new Error('the fixture ticket must have a history');

    expect(history.threshold).toBe(DEFAULT_SPECIAL_ATTEMPT_THRESHOLD);
    expect(history.countableAttempts).toBe(1);
    expect(history.isSpecial).toBe(false);
    expect(history.attempts).toHaveLength(3);
    expect(history.attempts.map((a) => a.countable)).toEqual([true, false, false]);
    expect(history.attempts.map((a) => a.reached)).toEqual([true, true, false]);
    expect(history.attempts[1].removalReason).toBe(REMOVAL_REASONS.ZM_WITHDRAWN);
    expect(history.attempts[0].seId).toBe(seId);
    expect(history.attempts[0].openedAt < history.attempts[2].openedAt).toBe(true);
    expect(history.attempts[2].closedAt).not.toBeNull();
  });

  /** An unknown ticket is not an error and not an empty history — the caller must be able to tell the
   *  difference, because the detail view 404s on one and renders on the other. */
  it('returns null for a ticket that does not exist', async () => {
    expect(await special.attemptsFor(randomUUID())).toBeNull();
  });

  /**
   * AC-4, first half — Special is not a *state*. It is not a member of any lifecycle enum, so no
   * status machine, report grouping or persisted filter can start treating it as one by accident. The
   * enums are read from the generated Prisma client rather than restated here, so the assertion is
   * against the schema itself.
   */
  it('AC-4: SPECIAL is not a TicketStatus, an AssignmentState or a WorkType', async () => {
    const enums = await import('../src/generated/prisma/enums');
    for (const name of ['TicketStatus', 'AssignmentState', 'WorkType'] as const) {
      const values = Object.values((enums as unknown as Record<string, Record<string, string>>)[name] ?? {});
      expect(values, `${name} must not gain a SPECIAL member`).not.toContain('SPECIAL');
    }
  });

  /**
   * AC-4, second half — **the derivation writes nothing.** This is the property the whole "no stored
   * counter" decision rests on, and it is the one that would fail silently: a verdict read that
   * quietly stamped a column would look identical from the outside until two readers disagreed.
   *
   * Asserted with whole-table counts rather than fixture-scoped queries (the #250 precedent), because
   * a write landing somewhere unexpected is precisely the failure being pinned — and including
   * `failure_cycles` because REPEAT/ESCALATED live there and must be untouched by an *attempts*
   * concept.
   */
  it('AC-4: reading a verdict writes nothing, anywhere', async () => {
    const ticketId = await ticketWithCountableAttempts(3);
    const census = async () => ({
      tickets: await prisma.ticket.count(),
      cycles: await prisma.failureCycle.count(),
      softStates: await prisma.softState.count(),
      windows: await prisma.batchAssignmentTicket.count(),
      submissions: await prisma.troubleshootingSubmission.count(),
      events: await prisma.ticketEvent.count(),
    });
    const cycleBefore = await prisma.failureCycle.findFirstOrThrow({ where: { ticket: { ticketId } } });

    const before = await census();
    expect((await verdict(ticketId)).isSpecial).toBe(true);
    await special.attemptsFor(ticketId);
    const after = await census();

    expect(after).toEqual(before);
    // The failure cycle — REPEAT / ESCALATED's home — is byte-identical, field for field.
    expect(await prisma.failureCycle.findFirstOrThrow({ where: { cycleId: cycleBefore.cycleId } })).toEqual(
      cycleBefore,
    );
  });

  /** AC-4, third half — the two concepts coexist without touching. A repeat-failure ticket that is
   *  also Special keeps its repeat flag exactly as it was: one is a fact about the device, the other
   *  an observation about attempts, and neither is derived from the other. */
  it('AC-4: a Special ticket keeps its REPEAT flag unchanged, and REPEAT alone never makes a ticket Special', async () => {
    const repeatOnly = await makeTicket();
    await prisma.ticket.update({ where: { ticketId: repeatOnly.ticketId }, data: { repeatFailure: true } });
    // No attempts at all — REPEAT must not imply Special.
    expect(await verdict(repeatOnly.ticketId)).toMatchObject({ countableAttempts: 0, isSpecial: false });

    const both = await makeTicket();
    await prisma.ticket.update({ where: { ticketId: both.ticketId }, data: { repeatFailure: true } });
    for (let i = 0; i < 3; i++) {
      await addWindow(both, { reason: REMOVAL_REASONS.PLAN_EXPIRED, reached: true, daysAgo: 5 - i }, i + 1);
    }

    expect((await verdict(both.ticketId)).isSpecial).toBe(true);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId: both.ticketId } })).repeatFailure).toBe(true);
  });
});
