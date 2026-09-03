import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * `/api/dashboard/action-required` — the nine Action Required cards (Issue 06 AC#1/AC#6, completed by
 * **#350**).
 *
 * **What #350 changed.** Five of the nine cards were permanent stubs (`available:false, count:0`), so
 * the panel painted "coming soon" over five of the manager's nine front doors and had done since Issue
 * 06 shipped. Every card is now counted from a real source, so `available` is `true` on all nine and
 * `count` is a fact rather than a placeholder.
 *
 * **`available` is still the contract, not decoration.** It says *"a source is wired"*, which is a
 * different statement from `count:0` meaning *"no work"*. It stays on the wire (and the Console's
 * attention band still renders the two differently) because the day a tenth card is added ahead of its
 * source, the distinction has to exist to be used.
 *
 * **The renamed card.** `critical_insertions_awaiting_accept` → `critical_escalations_pending`.
 * CONTEXT §21 retired SE Acceptance (#268/#279): there is no acceptance step for an insertion to be
 * awaiting, so the old key described a workflow the system does not have. It now counts
 * `IntradayInsertion` rows parked in `ESCALATION_REQUIRED` — the system's own way of saying "a manager
 * has to place this ticket" — which is what the card always meant to point at.
 *
 * **Why deltas, not absolute counts.** These run against the shared fixture database, whose row counts
 * move with every other spec. A card is proved wired by seeding exactly one row of its source and
 * showing that card — and only that card — moved by exactly one. An absolute assertion would either
 * be a tautology (`>= 0`) or flake.
 */
type Card = { key: string; label: string; urgency: number; count: number; available: boolean };

const ZM_ZONE = 1n;
const NS = Date.now().toString(36);

/** The nine cards, in urgency order — the wire contract this endpoint owes the dashboard. */
const EXPECTED_KEYS = [
  'unreviewed_batches',
  'vehicle_unavailability',
  'critical_escalations_pending',
  'failed_verification',
  'component_blocked',
  'waiting_component_overdue',
  'non_op_awaiting_manager',
  'manual_assignment_required',
  'recovery_stalled',
];

describe('#350 — /api/dashboard/action-required tells the truth', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let zmToken: string;
  let csmToken: string;

  let before: Map<string, Card>;
  let after: Map<string, Card>;
  let csmBefore: Map<string, Card>;
  let csmAfter: Map<string, Card>;

  // Everything this spec created, torn down in FK order.
  const created = {
    companyId: 0n,
    plantId: 0n,
    otherZoneId: 0n,
    otherPlantId: 0n,
    seId: '',
    scheduleId: 0n,
    batchId: 0n,
    runId: 0n,
    ticketIds: [] as string[],
    deviceIds: [] as string[],
    cycleIds: [] as string[],
    markingIds: [] as string[],
    insertionIds: [] as bigint[],
    blockIds: [] as bigint[],
  };

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const cards = async (token: string, zoneId?: string): Promise<Map<string, Card>> => {
    const res = await request(app.getHttpServer())
      .get(`/api/dashboard/action-required${zoneId ? `?zoneId=${zoneId}` : ''}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return new Map((res.body as Card[]).map((c) => [c.key, c]));
  };

  /** How far one card moved between the two snapshots. */
  const delta = (key: string, a: Map<string, Card>, b: Map<string, Card>): number =>
    (b.get(key)?.count ?? 0) - (a.get(key)?.count ?? 0);

  /** A device + its state row on the given plant — the join every device-shaped card scopes through. */
  const seedDevice = async (plantId: bigint): Promise<string> => {
    const deviceId = `dev-350-${NS}-${created.deviceIds.length}`;
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: { deviceId, plantId, companyId: created.companyId, computedAt: new Date() },
    });
    created.deviceIds.push(deviceId);
    return deviceId;
  };

  /**
   * An OPEN TROUBLESHOOT ticket with its Failure Cycle — `OPEN` is a TROUBLESHOOT-only status
   * (`tickets_work_type_status`, #309), and `TROUBLESHOOT ⇒ failure_cycle_id NOT NULL` is its sibling
   * CHECK, so this is the only shape that inserts.
   *
   * `assignmentState` is explicit on every call: three of the five cards below hang tickets off their
   * rows, and a ticket left accidentally UNASSIGNED would move `manual_assignment_required` too and
   * quietly break the "exactly one" assertions.
   */
  const seedTicket = async (opts: {
    plantId: bigint;
    assignmentState: 'UNASSIGNED' | 'FORMALLY_ASSIGNED';
    createdAt?: Date;
  }): Promise<string> => {
    const deviceId = await seedDevice(opts.plantId);
    const cycle = await prisma.failureCycle.create({
      data: { deviceId, state: 'OPEN', openedAt: new Date() },
    });
    created.cycleIds.push(cycle.cycleId);
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId: opts.plantId,
        companyId: created.companyId,
        companyTier: 'GOLD',
        assignmentState: opts.assignmentState,
        lastStateChangedAt: new Date(),
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    });
    created.ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    zmToken = await login('zm.north@fsm.test');
    csmToken = await login('csm@fsm.test');

    created.companyId = (
      await prisma.company.create({
        data: { name: `Co-350-${NS}`, companyTier: 'GOLD', companyPriorityRank: 'B' },
      })
    ).companyId;
    created.plantId = (await prisma.plant.create({ data: { name: `P-350-${NS}`, zoneId: ZM_ZONE } })).plantId;
    created.otherZoneId = (await prisma.zone.create({ data: { name: `Z-350-${NS}` } })).zoneId;
    created.otherPlantId = (
      await prisma.plant.create({ data: { name: `P-350-other-${NS}`, zoneId: created.otherZoneId } })
    ).plantId;

    const seUser = await prisma.user.create({
      data: {
        name: `SE 350 ${NS}`,
        role: 'SERVICE_ENGINEER',
        phone: `ph-350-${NS}`,
        email: `se-350-${NS}@fsm.test`,
        zoneId: ZM_ZONE,
      },
    });
    created.seId = seUser.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: created.seId, coverageType: 'MULTI_PLANT', zoneId: ZM_ZONE, dailyCapacity: 8 },
    });

    // `manual_assignment_required` counts tickets the day's dispatch pass already declined to place, so
    // the window has to exist BEFORE the baseline is taken — otherwise seeding the run and the ticket
    // together would move the card by however many fixture tickets the window newly caught.
    created.runId = (
      await prisma.dispatchRun.create({
        data: { trigger: 'MANUAL', status: 'SUCCESS', startedAt: new Date(), configSnapshot: {} },
      })
    ).runId;

    before = await cards(zmToken);
    csmBefore = await cards(csmToken);

    // 1. unreviewed_batches — one batch dispatched today into the ZM's zone, still exactly as the
    //    engine placed it.
    const schedule = await prisma.workSchedule.create({
      data: {
        seId: created.seId,
        zoneId: ZM_ZONE,
        dateFrom: new Date(),
        dateTo: new Date(),
        dispatchedAt: new Date(),
      },
    });
    created.scheduleId = schedule.scheduleId;
    created.batchId = (
      await prisma.plantBatchAssignment.create({
        data: {
          scheduleId: schedule.scheduleId,
          plantId: created.plantId,
          seId: created.seId,
          status: 'AUTO_ASSIGNED',
          stopSequence: 1,
        },
      })
    ).batchId;

    // 2. critical_escalations_pending — an insertion parked for a manager (§21: no acceptance step).
    const escalated = await seedTicket({
      plantId: created.plantId,
      assignmentState: 'FORMALLY_ASSIGNED',
    });
    created.insertionIds.push(
      (
        await prisma.intradayInsertion.create({
          data: {
            ticketId: escalated,
            zoneId: ZM_ZONE,
            status: 'ESCALATION_REQUIRED',
            offeredAt: new Date(),
          },
        })
      ).insertionId,
    );

    // 3. component_blocked — one open Component-Blocked Queue row.
    const blocked = await seedTicket({
      plantId: created.plantId,
      assignmentState: 'FORMALLY_ASSIGNED',
    });
    created.blockIds.push(
      (
        await prisma.componentBlockedQueue.create({
          data: {
            ticketId: blocked,
            seId: created.seId,
            reason: 'KIT_INCOMPLETE',
            missingComponents: [],
          },
        })
      ).id,
    );

    // 4. non_op_awaiting_manager — one marking waiting on the ZM's half of the dual confirmation.
    const nonOpDevice = await seedDevice(created.plantId);
    created.markingIds.push(
      (
        await prisma.nonOperationalMarking.create({
          data: { deviceId: nonOpDevice, state: 'AWAITING_ZM_CONFIRMATION', awaitingSince: new Date() },
        })
      ).markingId,
    );

    // 5. manual_assignment_required — open, unassigned, and older than the run above.
    await seedTicket({
      plantId: created.plantId,
      assignmentState: 'UNASSIGNED',
      createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });

    // Zone scoping: the same five sources again, one zone over. A ZM must not see any of them.
    const otherEscalated = await seedTicket({
      plantId: created.otherPlantId,
      assignmentState: 'FORMALLY_ASSIGNED',
    });
    created.insertionIds.push(
      (
        await prisma.intradayInsertion.create({
          data: {
            ticketId: otherEscalated,
            zoneId: created.otherZoneId,
            status: 'ESCALATION_REQUIRED',
            offeredAt: new Date(),
          },
        })
      ).insertionId,
    );
    const otherBlocked = await seedTicket({
      plantId: created.otherPlantId,
      assignmentState: 'FORMALLY_ASSIGNED',
    });
    created.blockIds.push(
      (
        await prisma.componentBlockedQueue.create({
          data: {
            ticketId: otherBlocked,
            seId: created.seId,
            reason: 'KIT_INCOMPLETE',
            missingComponents: [],
          },
        })
      ).id,
    );
    const otherNonOpDevice = await seedDevice(created.otherPlantId);
    created.markingIds.push(
      (
        await prisma.nonOperationalMarking.create({
          data: {
            deviceId: otherNonOpDevice,
            state: 'AWAITING_ZM_CONFIRMATION',
            awaitingSince: new Date(),
          },
        })
      ).markingId,
    );
    await seedTicket({
      plantId: created.otherPlantId,
      assignmentState: 'UNASSIGNED',
      createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });

    after = await cards(zmToken);
    csmAfter = await cards(csmToken);
  }, 120_000);

  afterAll(async () => {
    await prisma.componentBlockedQueue.deleteMany({ where: { id: { in: created.blockIds } } });
    await prisma.intradayInsertion.deleteMany({ where: { insertionId: { in: created.insertionIds } } });
    await prisma.nonOperationalMarking.deleteMany({ where: { markingId: { in: created.markingIds } } });
    if (created.batchId) await prisma.plantBatchAssignment.deleteMany({ where: { batchId: created.batchId } });
    if (created.scheduleId) await prisma.workSchedule.deleteMany({ where: { scheduleId: created.scheduleId } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: created.ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: created.cycleIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: created.deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: created.deviceIds } } });
    if (created.seId) {
      await prisma.engineerMaster.deleteMany({ where: { engineerId: created.seId } });
      await prisma.user.deleteMany({ where: { userId: created.seId } });
    }
    if (created.runId) await prisma.dispatchRun.deleteMany({ where: { runId: created.runId } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [created.plantId, created.otherPlantId] } } });
    await prisma.zone.deleteMany({ where: { zoneId: created.otherZoneId } });
    await prisma.company.deleteMany({ where: { companyId: created.companyId } });
    await app.close();
  }, 60_000);

  it('AC1/AC4 — returns the nine cards in urgency order, every one of them wired', () => {
    const keys = [...after.keys()];
    expect(keys).toEqual(EXPECTED_KEYS);
    // §21 — SE Acceptance was retired, so no card may claim something is awaiting it.
    expect(keys).not.toContain('critical_insertions_awaiting_accept');

    const urgencies = [...after.values()].map((c) => c.urgency);
    for (let i = 1; i < urgencies.length; i++) expect(urgencies[i]).toBeGreaterThan(urgencies[i - 1]);

    // Not one stub left: "coming soon" has no card to paint itself over.
    for (const c of after.values()) {
      expect(c.available).toBe(true);
      expect(c.count).toBeGreaterThanOrEqual(0);
    }
  });

  it.each([
    ['unreviewed_batches'],
    ['critical_escalations_pending'],
    ['component_blocked'],
    ['non_op_awaiting_manager'],
    ['manual_assignment_required'],
  ])('AC1 — one seeded row moves %s by exactly one', (key) => {
    expect(delta(key, before, after)).toBe(1);
  });

  it.each([
    ['vehicle_unavailability'],
    ['failed_verification'],
    ['waiting_component_overdue'],
    ['recovery_stalled'],
  ])('the four cards wired before #350 are untouched by the five new sources (%s)', (key) => {
    expect(delta(key, before, after)).toBe(0);
  });

  it('AC1 — a ZM sees only their own zone; the CSM sees both', () => {
    // Five rows were seeded in the ZM's zone and five one zone over. The ZM's totals moved by five.
    const zmMoved = EXPECTED_KEYS.reduce((n, k) => n + delta(k, before, after), 0);
    expect(zmMoved).toBe(5);
    // The CSM is pan-India, so both halves land — the four zone-scoped sources twice over, plus the
    // one batch, which was only ever seeded in the ZM's zone.
    const csmMoved = EXPECTED_KEYS.reduce((n, k) => n + delta(k, csmBefore, csmAfter), 0);
    expect(csmMoved).toBe(9);
  });

  /**
   * **B5 — `?zoneId=` is a correctness fix.** These counts are global for a CSM/OH, which was right on
   * a pan-India dashboard and wrong beside the Scheduler Console's single-zone deck: the two panes
   * would disagree about how much trouble that zone is in.
   */
  it('narrows a CSM to one zone when asked, and never widens a ZM', async () => {
    const total = (m: Map<string, Card>) =>
      [...m.values()].filter((c) => c.available).reduce((n, c) => n + c.count, 0);

    const global = await cards(csmToken);
    const scoped = await cards(csmToken, String(ZM_ZONE));
    expect(total(scoped)).toBeLessThanOrEqual(total(global));
    // The zone seeded one zone over is genuinely excluded, not merely "not more".
    const narrowed = await cards(csmToken, String(created.otherZoneId));
    expect(narrowed.get('critical_escalations_pending')?.count).toBe(1);
    expect(narrowed.get('unreviewed_batches')?.count).toBe(0);

    // A ZM is clamped by scope, so naming a zone they do not own must not move their answer.
    const own = await cards(zmToken);
    const tryWiden = await cards(zmToken, '99999');
    expect(total(tryWiden)).toBe(total(own));
  });

  it('forbids a Service Engineer', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/dashboard/action-required')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
