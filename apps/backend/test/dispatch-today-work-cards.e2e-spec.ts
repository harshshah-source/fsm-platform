import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { DispatchTodayQueryService } from '../src/scheduling/dispatch-today-query.service';
import { OverrideService } from '../src/scheduling/override.service';
import { PrismaSoftStateConflictPort } from '../src/soft-state/soft-state-conflict.adapter';
import { DEFAULT_ASSIGNED_UNTOUCHED_AGING_HOURS } from '../src/settings/aging-threshold';

/**
 * #295 — the work card's data contract.
 *
 * The Console used to draw a ticket as `ticketId.slice(0, 8)`: eight hex characters, from which no
 * dispatcher has ever learnt anything. The card that replaces it names the physical things an
 * operator actually reasons about — the device, the vehicle, the company, the transporter — and says
 * in one word whether anybody has started the work.
 *
 * **Every assertion here is about the payload, not the pixels.** The rule the surface follows is that
 * business meaning is decided once, on the server, and rendered as given; a client that re-derived
 * "is this aged" from an hour count and a threshold would be a second implementation of a business
 * rule, which is how `chronicThreshold` came to be dead on arrival (Risk 1 of the 2026-09-01
 * investigation, fixed in the same slice as this).
 */
const NS = Date.now();
const TODAY = new Date('2026-06-28T06:00:00Z');

describe('#295 — the dispatch board work card', () => {
  let prisma: PrismaService;
  let svc: DispatchTodayQueryService;
  let override: OverrideService;

  let zoneId: bigint;
  let foreignZoneId: bigint;
  let foreignPlantId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let transporterId: bigint;
  let zmUserId: string;
  let se: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const vehicleIds: bigint[] = [];

  const scope = () => ({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });

  /** The card's own view of one ticket, wherever it sits on the board. */
  const cardFor = async (ticketId: string) => {
    const view = await svc.today(scope(), { zoneId, now: TODAY });
    return view.engineers
      .flatMap((e) => e.stops)
      .flatMap((s) => s.tickets)
      .find((t) => t.ticketId === ticketId);
  };

  /**
   * A ticket with as much or as little identity as the case under test needs. `inactivityHours: null`
   * is a real state — a device whose state row has never been recomputed — and is deliberately
   * expressible here, because rendering it as `0` would tell an operator the device reported in just
   * now.
   */
  const makeTicket = async (opts: {
    withVehicle?: boolean;
    inactivityHours?: number | null;
    failureCycles?: number;
  } = {}): Promise<string> => {
    const deviceId = String(11_950_000_000 + ((NS + deviceIds.length) % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);

    let vehicleId: bigint | null = null;
    if (opts.withVehicle !== false) {
      const v = await prisma.vehicle.create({
        data: {
          vehicleNo: `MH-${NS % 100}-${deviceIds.length}`,
          plantId,
          companyId,
          transporterId,
          status: 'ACTIVE',
        },
      });
      vehicleIds.push(v.vehicleId);
      vehicleId = v.vehicleId;
    }

    await prisma.device.create({ data: { deviceId, currentVehicleId: vehicleId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        inactivityHours: opts.inactivityHours === undefined ? 18 : opts.inactivityHours,
        latestGpsDatetime: new Date(TODAY.getTime() - 18 * 3_600_000),
        plantId,
        companyId,
        computedAt: TODAY,
      },
    });

    // The open episode the ticket hangs off, plus any extra closed history the chronic count reads.
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: TODAY } });
    for (let i = 1; i < (opts.failureCycles ?? 1); i++) {
      await prisma.failureCycle.create({
        data: {
          deviceId,
          state: 'VERIFIED',
          openedAt: new Date(TODAY.getTime() - (i + 1) * 86_400_000),
          closedAt: new Date(TODAY.getTime() - i * 86_400_000),
          repeatFailure: true,
        },
      });
    }

    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        vehicleId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: TODAY,
      },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  /** A ticket in a zone this suite's ZM does not hold — the enumeration case the clamp must refuse. */
  const makeForeignZoneTicket = async (): Promise<string> => {
    const deviceId = String(11_960_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: TODAY } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId: foreignPlantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: TODAY,
      },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  /** Assign through the real manual path, then pin how long ago that assignment happened. */
  const assign = async (ticketId: string, hoursAgo = 0): Promise<void> => {
    const r = await override.assignTicket(
      ticketId,
      se,
      scope(),
      { userId: zmUserId, role: 'ZONAL_MANAGER', actedAsRole: null },
      TODAY,
    );
    expect(r.result).toBe('OK');
    // `created_at` defaults to the wall clock, and this suite's `now` is a frozen date — so the age
    // is set explicitly rather than inferred. This IS the aging clock (#295): the moment the work
    // became somebody's, not the moment the device went quiet.
    await prisma.batchAssignmentTicket.updateMany({
      where: { ticketId, removedAt: null },
      data: { createdAt: new Date(TODAY.getTime() - hoursAgo * 3_600_000) },
    });
  };

  const startTroubleshooting = async (ticketId: string): Promise<void> => {
    await prisma.softState.create({
      data: { ticketId, seId: se, type: 'TROUBLESHOOT_STARTED', setAt: TODAY },
    });
  };

  /** A filed troubleshooting report. `submittedAt` is the whole point — it decides which assignment
   *  window the report belongs to. */
  const submitReport = async (ticketId: string, submittedAt: Date = TODAY): Promise<void> => {
    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { ticketId },
      select: { failureCycleId: true },
    });
    await prisma.troubleshootingSubmission.create({
      data: {
        ticketId,
        failureCycleId: ticket.failureCycleId!,
        submissionType: 'TROUBLESHOOTING_FORM',
        clientSubmissionId: randomUUID(),
        seId: se,
        presenceSource: 'FORM_GPS',
        rootCauseCategory: 'POWER_ISSUE',
        submittedAt,
        photoRefs: [],
      },
    });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());
    svc = new DispatchTodayQueryService(prisma, new PrismaSoftStateConflictPort(prisma));

    const zm = await prisma.user.create({
      data: { name: 'ZM ' + NS, role: 'ZONAL_MANAGER', phone: 'zm295-' + NS, email: `zm-${NS}@p295.test` },
    });
    zmUserId = zm.userId;
    userIds.push(zm.userId);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-295-' + NS, zonalManagerUserId: zm.userId } })).zoneId;
    companyId = (
      await prisma.company.create({
        data: { name: 'Northbound Cement ' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' },
      })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-295-' + NS, zoneId } })).plantId;
    foreignZoneId = (await prisma.zone.create({ data: { name: 'Z2-295-' + NS } })).zoneId;
    foreignPlantId = (
      await prisma.plant.create({ data: { name: 'P2-295-' + NS, zoneId: foreignZoneId } })
    ).plantId;
    transporterId = (
      await prisma.transporter.create({ data: { name: 'Sharma Logistics ' + NS, companyId } })
    ).transporterId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@p295.test`, zoneId },
    });
    se = u.userId;
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: se, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: 20 },
    });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'MULTI_PLANT' } });
  });

  afterAll(async () => {
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.vehicle.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
    await prisma.transporter.deleteMany({ where: { transporterId } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.engineerMaster.deleteMany({ where: { zoneId } });
    await prisma.plant.deleteMany({ where: { zoneId: { in: [zoneId, foreignZoneId] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneId, foreignZoneId] } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.onModuleDestroy();
  });

  describe('AC1 — the physical identity an operator reasons about', () => {
    let ticketId: string;

    beforeAll(async () => {
      ticketId = await makeTicket({ inactivityHours: 18, failureCycles: 4 });
      await assign(ticketId);
    });

    it('carries device, vehicle, company, transporter and inactivity on the ticket', async () => {
      const card = await cardFor(ticketId);

      expect(card).toBeDefined();
      expect(card!.deviceId).toBe(deviceIds[deviceIds.length - 1]);
      expect(card!.vehicleNo).toMatch(/^MH-/);
      expect(card!.companyName).toContain('Northbound Cement');
      expect(card!.transporterName).toContain('Sharma Logistics');
      // A number, not a Decimal — the client compares and formats it, and a Prisma Decimal serialises
      // as a string that `> 24` would silently compare wrong.
      expect(card!.inactivityHours).toBe(18);
      expect(typeof card!.inactivityHours).toBe('number');
    });

    it('keeps the plant on the stop rather than copying it onto every ticket', async () => {
      const view = await svc.today(scope(), { zoneId, now: TODAY });
      const stop = view.engineers.flatMap((e) => e.stops).find((s) => s.tickets.some((t) => t.ticketId === ticketId));
      expect(stop!.plantName).toContain('P-295-');
    });

    it('keeps ticketId as the identity — the device number is a label, never a key', async () => {
      const card = await cardFor(ticketId);
      expect(card!.ticketId).toBe(ticketId);
    });

    it('carries when the work became somebody’s, so the age is a fact and not a guess', async () => {
      const card = await cardFor(ticketId);
      expect(card!.assignedAt).toBe(TODAY.toISOString());
    });

    /**
     * Risk 1 of the investigation. `failureCycles` was hardcoded `null` beside a comment naming an
     * `attachFailureCycles` that never existed, and `chronicThreshold` was declared required by the
     * client and never sent — so `failureCycles >= undefined` was permanently false and the `CHR ×n`
     * token could not light for any ticket in production. It was green only because six admin
     * fixtures hand-wrote the threshold and no backend test asserted either field.
     */
    it('counts the device’s failure cycles instead of publishing a permanent null', async () => {
      const card = await cardFor(ticketId);
      expect(card!.failureCycles).toBe(4);
    });
  });

  describe('AC2 — absent data stays absent', () => {
    it('a ticket with no vehicle reports no vehicle and no transporter, never a placeholder', async () => {
      const ticketId = await makeTicket({ withVehicle: false });
      await assign(ticketId);

      const card = await cardFor(ticketId);
      expect(card!.vehicleNo).toBeNull();
      expect(card!.transporterName).toBeNull();
      // The company is on the ticket itself, so it survives a missing vehicle.
      expect(card!.companyName).toContain('Northbound Cement');
    });

    /**
     * `inactivity_hours` is nullable and **null means "never recomputed"**, which is not the same
     * fact as "silent for zero hours". Rendering the second where the first is true would tell a
     * dispatcher the device had just reported in.
     */
    it('a device state that has never been recomputed reports null, not zero', async () => {
      const ticketId = await makeTicket({ inactivityHours: null });
      await assign(ticketId);

      expect((await cardFor(ticketId))!.inactivityHours).toBeNull();
    });
  });

  describe('AC3 — the action status, and the two clocks it must not confuse', () => {
    it('NOT_STARTED while nobody has touched a fresh assignment', async () => {
      const ticketId = await makeTicket();
      await assign(ticketId, 1);

      const card = await cardFor(ticketId);
      expect(card!.troubleshootingStarted).toBe(false);
      expect(card!.actionStatus).toBe('NOT_STARTED');
    });

    it('AGING_UNTOUCHED once the assignment has sat past the threshold', async () => {
      const ticketId = await makeTicket();
      await assign(ticketId, DEFAULT_ASSIGNED_UNTOUCHED_AGING_HOURS + 6);

      expect((await cardFor(ticketId))!.actionStatus).toBe('AGING_UNTOUCHED');
    });

    it('IN_PROGRESS once troubleshooting has started — and it outranks any age', async () => {
      const ticketId = await makeTicket();
      await assign(ticketId, 48);
      await startTroubleshooting(ticketId);

      const card = await cardFor(ticketId);
      expect(card!.troubleshootingStarted).toBe(true);
      expect(card!.actionStatus).toBe('IN_PROGRESS');
    });

    /**
     * The distinction the whole field exists for. An engineer who has arrived and not begun has not
     * started the work — and `activeOnSiteTicketIds`, the read this could most easily have been built
     * on, would have said they had.
     */
    it('an engineer who is ON_SITE but has not started is not in progress', async () => {
      const ticketId = await makeTicket();
      await assign(ticketId, 1);
      await prisma.softState.create({ data: { ticketId, seId: se, type: 'ON_SITE', setAt: TODAY } });

      const card = await cardFor(ticketId);
      expect(card!.troubleshootingStarted).toBe(false);
      expect(card!.actionStatus).toBe('NOT_STARTED');
    });

    it('a resolved TROUBLESHOOT_STARTED no longer claims work is in progress', async () => {
      const ticketId = await makeTicket();
      await assign(ticketId, 1);
      await prisma.softState.create({
        data: {
          ticketId,
          seId: se,
          type: 'TROUBLESHOOT_STARTED',
          setAt: TODAY,
          resolvedAt: TODAY,
          resolvedBy: 'ZM',
          resolutionReason: 'OVERRIDE',
        },
      });

      expect((await cardFor(ticketId))!.troubleshootingStarted).toBe(false);
    });

    /**
     * **The engineer who finished the job must not read as the engineer who never started.**
     *
     * Submitting a troubleshooting report **resolves** every unresolved soft state for that
     * `(ticket, se)` pair — `troubleshoot-submission.service.ts:157-160`, stamped `FORM_SUBMITTED` —
     * while the assignment row itself stays live: nothing retires it until a ZM makes a verification
     * decision (`close-assignment.ts:42-50`, called only from the terminal paths), and the ticket
     * moves to `VERIFICATION_PENDING`, which is not a resolved status.
     *
     * So a literal reading of "unresolved TROUBLESHOOT_STARTED" flips a finished job from green back
     * to red the moment the engineer files their report, and then to amber as the assignment ages —
     * telling a dispatcher to chase work that is done and waiting on their own colleague. The
     * submission is evidence within the same assignment window (#244's idiom), and it counts.
     */
    it('a submitted report keeps the card green — a finished job is not an untouched one', async () => {
      const ticketId = await makeTicket();
      await assign(ticketId, 12);
      // The engineer started, then filed — exactly what the submission service writes.
      await startTroubleshooting(ticketId);
      await prisma.softState.updateMany({
        where: { ticketId, resolvedAt: null },
        data: { resolvedAt: TODAY, resolvedBy: 'SE', resolutionReason: 'FORM_SUBMITTED' },
      });
      await submitReport(ticketId);

      const card = await cardFor(ticketId);
      expect(card!.troubleshootingStarted).toBe(true);
      expect(card!.actionStatus).toBe('IN_PROGRESS');
    });

    /**
     * The window matters, or a device fixed last month would keep this month's dispatch green. The
     * submission has to fall inside *this* assignment, which is the same bound #244 uses to decide an
     * attempt was reached.
     */
    it('a submission from a previous assignment does not vouch for the current one', async () => {
      const ticketId = await makeTicket();
      await assign(ticketId, 12);
      await submitReport(ticketId, new Date(TODAY.getTime() - 30 * 86_400_000));

      expect((await cardFor(ticketId))!.actionStatus).toBe('AGING_UNTOUCHED');
    });

    /**
     * **Inactivity is not aging.** A device silent for 40 hours whose ticket was dispatched ten
     * minutes ago is untouched-but-fresh: the fleet problem is old, the dispatch decision is not, and
     * nobody is owed a nudge yet. Building the colour on `inactivity_hours` — the tempting shortcut,
     * since it is right there on the card — would have made this ticket yellow the instant it landed.
     */
    it('a long-silent device with a brand-new assignment is untouched, not aged', async () => {
      const ticketId = await makeTicket({ inactivityHours: 40 });
      await assign(ticketId, 0.2);

      const card = await cardFor(ticketId);
      expect(card!.inactivityHours).toBe(40);
      expect(card!.actionStatus).toBe('NOT_STARTED');
    });
  });

  describe('AC4 — the rules travel with the data', () => {
    it('publishes the aging threshold, so no client re-derives when yellow starts', async () => {
      const view = await svc.today(scope(), { zoneId, now: TODAY });
      expect(view.agingThresholdHours).toBe(DEFAULT_ASSIGNED_UNTOUCHED_AGING_HOURS);
    });

    /** The other half of Risk 1: the client has declared this required since Phase 3.4. */
    it('publishes the chronic threshold the CHR token has always needed', async () => {
      const view = await svc.today(scope(), { zoneId, now: TODAY });
      expect(typeof view.chronicThreshold).toBe('number');
      expect(view.chronicThreshold).toBeGreaterThan(0);
    });
  });

  /**
   * AC6 — **the same identity, for a day that is not today.**
   *
   * A committed future column knows its ticket ids (`GET /schedules?detail=stops`) and nothing else:
   * no device, no vehicle, no company, no transporter. Fetching each card's identity one request at a
   * time would be the N+1 this whole design avoids on today's column, so the future column asks once
   * for all of them.
   *
   * Deliberately **no `actionStatus`** in the answer. Troubleshooting has not started on work whose
   * day has not begun, and an untouched-and-aging verdict about Wednesday is not a fact — it is a
   * category error. The column renders identity and says "committed"; the colour belongs to the day
   * the work is actually live.
   */
  describe('AC6 — batched card summaries for a non-today column', () => {
    let mine: string;
    let elsewhere: string;

    beforeAll(async () => {
      mine = await makeTicket();
      elsewhere = await makeForeignZoneTicket();
    });

    it('answers with the same identity fields the board card carries', async () => {
      const { summaries } = await svc.cardSummaries(scope(), { zoneId, ticketIds: [mine] });

      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        ticketId: mine,
        companyName: expect.stringContaining('Northbound Cement'),
        transporterName: expect.stringContaining('Sharma Logistics'),
      });
      expect(summaries[0].vehicleNo).toMatch(/^MH-/);
      expect(summaries[0].inactivityHours).toBe(18);
      // The verdict is not the future's to give.
      expect(summaries[0]).not.toHaveProperty('actionStatus');
    });

    /**
     * The endpoint takes ids from the client, so it is an enumeration surface unless it is clamped:
     * a ZM guessing ids must not be able to read another zone's fleet through it. Filtered by the
     * ticket's plant zone, which is the same predicate `heldToday` scopes on.
     */
    it('silently omits a ticket outside the caller’s zone rather than answering for it', async () => {
      const { summaries } = await svc.cardSummaries(scope(), { zoneId, ticketIds: [mine, elsewhere] });

      expect(summaries.map((s) => s.ticketId)).toEqual([mine]);
    });

    it('refuses a zone the caller does not hold, exactly as the board read does', async () => {
      await expect(
        svc.cardSummaries(scope(), { zoneId: foreignZoneId, ticketIds: [mine] }),
      ).rejects.toThrow();
    });

    it('answers an empty request with an empty list rather than a 500', async () => {
      await expect(svc.cardSummaries(scope(), { zoneId, ticketIds: [] })).resolves.toEqual({
        summaries: [],
      });
    });

    /** A cap, because an unbounded id list is an unbounded query. Refused by name, not truncated —
     *  a silently shortened answer would leave cards blank with no way to find out why. */
    it('refuses an oversized request with a stated code instead of truncating it', async () => {
      // Repeating one id, so the cap is proven to bind on what was sent rather than on what survives
      // de-duplication — otherwise a client could walk past it with a hundred thousand duplicates.
      const tooMany = Array.from({ length: 501 }, () => mine);
      await expect(svc.cardSummaries(scope(), { zoneId, ticketIds: tooMany })).rejects.toMatchObject({
        response: { code: 'TOO_MANY_TICKETS' },
      });
    });
  });

  /**
   * AC5 — **one batched read per concern, whatever the board holds.**
   *
   * A card needs five joins and a soft-state lookup. Done per ticket that is six queries per chip on
   * a board that routinely carries hundreds, which is the difference between a page and an outage.
   * The enrichment therefore follows the payload's existing `bucketByTicket` / `returnDueToday`
   * idiom: one query over every id at once.
   */
  describe('AC5 — enrichment is batched, not per card', () => {
    it('issues a fixed number of enrichment queries however many tickets are on the board', async () => {
      /**
       * Instrumented by wrapping the delegate method and restoring it by assignment, rather than
       * `vi.spyOn`: Prisma's model delegates are proxies with no own property descriptors, so a
       * spy's `mockRestore` leaves the method undefined for the next pass.
       */
      const countCalls = async (): Promise<Record<string, number>> => {
        const targets = [
          ['ticket', 'findMany'],
          ['deviceState', 'findMany'],
          ['softState', 'findMany'],
          ['failureCycle', 'groupBy'],
        ] as const;
        const counts: Record<string, number> = {};
        const restore: (() => void)[] = [];

        for (const [model, method] of targets) {
          const delegate = (prisma as unknown as Record<string, Record<string, unknown>>)[model];
          const original = (delegate[method] as (...a: unknown[]) => unknown).bind(delegate);
          const key = `${model}.${method}`;
          counts[key] = 0;
          delegate[method] = (...args: unknown[]) => {
            counts[key] += 1;
            return original(...args);
          };
          restore.push(() => {
            delegate[method] = original;
          });
        }

        await svc.today(scope(), { zoneId, now: TODAY });
        for (const r of restore) r();
        return counts;
      };

      const before = await countCalls();
      // The instrument has to be watching something, or the comparison below is vacuously true.
      expect(before['ticket.findMany']).toBeGreaterThan(0);
      expect(before['failureCycle.groupBy']).toBeGreaterThan(0);

      // Five more cards on the same board. A per-ticket implementation would grow every counter.
      for (let i = 0; i < 5; i++) await assign(await makeTicket(), 1);
      const after = await countCalls();

      expect(after).toEqual(before);
    });
  });
});
