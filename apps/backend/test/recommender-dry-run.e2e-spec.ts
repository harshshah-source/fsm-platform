import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * #250 — the recommender's dry-run seam, the foundation the admin preview (#251) stands on.
 *
 * Approved Decision 1/18: the preview must project the **real** recommender, never a second scheduling
 * implementation. That rules out re-deriving the plan in a preview service — the only honest way to
 * answer "what would tomorrow's run do" is to run the real selection and refuse to let it write.
 *
 * `runForZone` was mutating by construction: six distinct writes, one of which
 * (`clearFinalizedOrphans`) is a **zone-wide `deleteMany`** that would take out a concurrent live
 * run's SUGGESTED rows. So "just call it and roll back" was never available either — the preview has
 * to take no lock, no in-flight slot, and no ledger row, which means it cannot borrow the real run's
 * transaction boundary.
 *
 * The suppression is asserted by **table counts across the whole database**, not by inspecting the
 * fixture's own rows: a write that lands somewhere unexpected is exactly the failure this pins, and a
 * fixture-scoped assertion would not see it. Files run serially (`fileParallelism: false`), so a
 * whole-table delta is stable.
 */
const NS = Date.now();
const NOW = new Date('2026-06-21T06:00:00Z');

describe('#250 — recommender dry-run seam', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  let ticketId: string;

  /** Every table the run could write to — the six in-run mutations plus the four dispatch tables. */
  const countAll = async () => ({
    recommendations: await prisma.recommendation.count(),
    traces: await prisma.dispatchDecisionTrace.count(),
    componentBlocked: await prisma.componentBlockedQueue.count(),
    schedules: await prisma.workSchedule.count(),
    batches: await prisma.plantBatchAssignment.count(),
    batchTickets: await prisma.batchAssignmentTicket.count(),
    runs: await prisma.dispatchRun.count(),
  });

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(12_300_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        inactivityHours: 48,
        latestGpsDatetime: new Date(NOW.getTime() - 48 * 3_600_000),
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

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-dr-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-dr-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-dr-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@dr.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });

    ticketId = await makeTicket();
  });

  afterAll(async () => {
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.componentBlockedQueue.deleteMany({ where: { ticketId: { in: ticketIds } } });
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
    await prisma.onModuleDestroy();
  });

  /**
   * AC-1 — the suppression itself. A dry run against a zone with genuinely dispatchable work must
   * leave every table byte-identical while still reaching a decision.
   */
  it('AC-1: a dry run writes nothing anywhere and still decides', async () => {
    const before = await countAll();
    const summary = await rec.runForZone(zoneId, { now: NOW, dryRun: true });
    const after = await countAll();

    expect(after).toEqual(before);
    // It decided — suppression must not be achieved by simply not running the engine.
    expect(summary.recommended).toBe(1);
    expect(summary.ticketsConsidered).toBe(1);
  });

  /**
   * AC-3 — the projection has to carry what the writes would have carried, or #251 has nothing to
   * render. The per-ticket decision detail mirrors the `dispatch_decision_traces` payload the real run
   * persists, and the `se → plant → tickets` grouping mirrors what `dispatchForZone` would build.
   */
  it('AC-3: the projection carries the decision, the plan grouping, and bucketsAsOf', async () => {
    const summary = await rec.runForZone(zoneId, { now: NOW, dryRun: true });
    const p = summary.projection;
    expect(p).toBeDefined();

    expect(p!.decisions).toHaveLength(1);
    const d = p!.decisions[0];
    expect(d.ticketId).toBe(ticketId);
    expect(d.seId).toBe(se);
    expect(d.processingRank).toBe(1);
    expect(d.deviceBucket).toBe('CRITICAL');
    expect(d.candidatesTotal).toBe(1);
    expect(d.passedCount).toBe(1);
    expect(d.poolEmptyReason).toBeNull();
    expect(d.score).toBeGreaterThan(0);

    // The projected day plan: one SE, one plant stop, one ticket.
    expect(p!.plan).toEqual([{ seId: se, plants: [{ plantId: String(plantId), ticketIds: [ticketId] }] }]);

    // The honest limit #251 has to display: SLA buckets and inactivity are materialised as of the last
    // recompute, so even a D+1 preview ranks on today's buckets. Stating the watermark is the whole
    // point — a preview that hid this would look authoritative about a ranking it cannot know.
    expect(p!.bucketsAsOf).toBe(NOW.toISOString());
    expect(p!.targetDate).toBe('2026-06-21');
  });

  /**
   * AC-4 — the guarantee the whole decision rests on: the preview *is* the real recommender, so its
   * answer for today must equal what the real run would do, not merely resemble it.
   *
   * Ordered dry-run-first deliberately. Because a dry run writes nothing, the real run that follows
   * starts from a byte-identical database — so this is a true same-input comparison, and it doubles
   * as a second, independent proof of AC-1 (had the dry run written, the real run's
   * `clearFinalizedOrphans` + re-create would still produce rows, but the counts would not line up).
   *
   * Three tickets on one plant, so the comparison covers processing order and the plant-cluster seed
   * rather than a single trivial decision.
   */
  it('AC-4: a dry run for today reaches the same decisions as the real run', async () => {
    await makeTicket();
    await makeTicket();
    // Start both runs from the same clean slate — the control test above left a real recommendation.
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });

    const dry = await rec.runForZone(zoneId, { now: NOW, dryRun: true });
    const real = await rec.runForZone(zoneId, { now: NOW });

    expect(dry.recommended).toBe(real.recommended);
    expect(dry.unassignable).toBe(real.unassignable);
    expect(dry.ticketsConsidered).toBe(real.ticketsConsidered);
    expect(dry.mode).toBe(real.mode);

    const persisted = await prisma.recommendation.findMany({
      where: { ticketId: { in: ticketIds } },
      orderBy: { processingRank: 'asc' },
      select: { ticketId: true, seId: true, processingRank: true, status: true },
    });
    const projected = dry.projection!.decisions.map((d) => ({
      ticketId: d.ticketId,
      seId: d.seId,
      processingRank: d.processingRank,
      status: d.seId === null ? 'UNASSIGNABLE' : 'SUGGESTED',
    }));
    expect(projected).toEqual(persisted);
    expect(projected).toHaveLength(3);
  });

  /**
   * AC-2 — the date-bound reads move to the target day. A ZM-deferred ticket is the sharpest probe
   * available: `notDeferredOn` is evaluated against the run day, so the ticket is invisible today and
   * dispatchable tomorrow, and no other input has to change for the difference to show.
   */
  it('AC-2: a ticket deferred until tomorrow appears in tomorrow’s preview, not today’s', async () => {
    const deferred = await makeTicket();
    const tomorrow = new Date('2026-06-22T00:00:00Z'); // the IST day after NOW's
    await prisma.ticket.update({ where: { ticketId: deferred }, data: { deferredUntil: tomorrow } });

    const today = await rec.runForZone(zoneId, { now: NOW, dryRun: true });
    expect(today.projection!.targetDate).toBe('2026-06-21');
    expect(today.projection!.decisions.map((d) => d.ticketId)).not.toContain(deferred);

    const preview = await rec.runForZone(zoneId, { now: NOW, dryRun: true, targetDate: tomorrow });
    expect(preview.projection!.targetDate).toBe('2026-06-22');
    expect(preview.projection!.decisions.map((d) => d.ticketId)).toContain(deferred);

    // `now` is unchanged, so the wall-clock age terms are identical — only the day-bound reads moved.
    expect(preview.projection!.bucketsAsOf).toBe(today.projection!.bucketsAsOf);
  });

  /**
   * The control for AC-1: suppression is a property of the *flag*, not of the fixture. Without it the
   * identical call writes. Asserted against a cleared slate and against the run's own tallies rather
   * than a hard-coded count, so it does not depend on which tests ran before it.
   */
  it('AC-1 control: without the flag the same call writes real rows', async () => {
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    const before = await countAll();
    const summary = await rec.runForZone(zoneId, { now: NOW });
    const after = await countAll();

    expect(summary.projection).toBeUndefined();
    expect(summary.recommended).toBeGreaterThan(0);
    expect(after.recommendations).toBe(before.recommendations + summary.recommended + summary.unassignable);
  });
});
