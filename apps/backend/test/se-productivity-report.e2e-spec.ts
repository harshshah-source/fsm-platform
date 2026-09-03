import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ReportsService,
  SE_PRODUCTIVITY_RATE_MIN_SAMPLE,
  type SeProductivityReport,
  type SeProductivityRow,
} from '../src/reports/reports.service';

/**
 * #365 — `ReportsService.seProductivity`, the read behind `/reports/se-productivity`
 * (design: `docs/ui/desktop/approved-designs/se-productivity-report.html`).
 *
 * Four things this suite exists to pin, in the order they matter:
 *
 * 1. **Repair and Departure are separate numbers** (audit F7). A `DEVICE_UNDEPLOYED_CLOSE` is a
 *    vehicle leaving the fleet, not work; folded into the repair count it makes the engineer with the
 *    unluckiest plants look like the most productive one, on the page staffing decisions come from.
 * 2. **Rates are withheld below {@link SE_PRODUCTIVITY_RATE_MIN_SAMPLE} closures, and counts never
 *    are.** A six-closure engineer has no first-time-fix percentage worth printing; six closures is
 *    still a true fact about six jobs.
 * 3. **The roster is the row set.** An engineer who closed nothing gets a row, because "did nothing
 *    this month" is an answer to the question the page is opened with.
 * 4. **The zone clamp is server-side**, and the response echoes the clamped zone so the page's scope
 *    chip states the zone the numbers are actually from.
 *
 * The window is June 2026 and every fixture instant is inside it, so nothing here depends on the
 * wall clock. Engineers are named `A…`/`B…`/`C…` because the default ordering is by name — asserting
 * on the order is asserting that the server does not pre-sort worst-first.
 */
const NS = Date.now();
const MONTH_PARAM = '2026-06';
const JUNE = (day: number, hour = 9): Date => new Date(Date.UTC(2026, 5, day, hour));
/** Monday 15 June 2026 — the anchor for the weekly-granularity case (its week is 15–21 June). */
const WEEK_OF = '2026-06-17'; // a Wednesday: the window must resolve to its Monday, not to this day

const OH = { role: 'OPERATIONS_HEAD', zoneId: null };

describe('#365 — ReportsService.seProductivity', () => {
  let prisma: PrismaService;
  let service: ReportsService;

  let zoneA: bigint;
  let zoneB: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let deviceId: string;

  /** `A Ramesh` — a full-sample engineer: 12 repairs + 3 departures = 15 closures. */
  let seRamesh: string;
  /** `B Manoj` — 4 repairs + 2 departures = 6 closures, below the floor. */
  let seManoj: string;
  /** `C Idle` — on the roster, closed nothing. */
  let seIdle: string;
  /** `Z Other` — in zone B, so a zone-A ZM must never see them. */
  let seOther: string;

  const userIds: string[] = [];
  const scheduleIds: bigint[] = [];
  const batchBySe = new Map<string, bigint>();
  const ticketIds: string[] = [];
  const cycleIds: string[] = [];

  const makeSe = async (
    name: string,
    coverageType: 'DEDICATED' | 'MULTI_PLANT' | 'FLOATING',
    zoneId: bigint,
    plantId: bigint,
  ): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name, role: 'SERVICE_ENGINEER', phone: `ph-sep-${tag}`, email: `sep-${tag}@fsm.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType, zoneId, dailyCapacity: 8 } });
    const schedule = await prisma.workSchedule.create({
      data: { seId: u.userId, zoneId, dateFrom: JUNE(1, 0), dateTo: JUNE(30, 0) },
    });
    scheduleIds.push(schedule.scheduleId);
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId: u.userId, stopSequence: 1 },
    });
    batchBySe.set(u.userId, batch.batchId);
    return u.userId;
  };

  /**
   * One closed TROUBLESHOOT ticket attributed to `seId`.
   *
   * A **repair** (`closureType: null`) also gets a submission, a soft state and a verification run,
   * because that is what a real repair leaves behind and those three rows are what the first-time-fix,
   * failed-verification and on-site → submission columns read. A **departure** gets none of them — it
   * is attributed only by the batch assignment, which is the whole reason that fallback leg exists.
   */
  const closeTicket = async (
    seId: string,
    opts: {
      closureType: 'DEVICE_UNDEPLOYED_CLOSE' | null;
      closedAt: Date;
      plantId?: bigint;
      /** Defaults true — a first-time fix (VERIFIED, no repeat, no SLA pause). */
      firstTime?: boolean;
      /** `null` = no verification run at all. */
      verification?: 'CLOSED' | 'FAILED_VERIFICATION' | null;
      /** Seconds between ON_SITE and the submission; omitted = no stage-time pair. */
      onsiteToSubmitSeconds?: number;
    },
  ): Promise<string> => {
    const repair = opts.closureType === null;
    const firstTime = opts.firstTime ?? true;
    const cycle = await prisma.failureCycle.create({
      data: {
        deviceId,
        state: 'VERIFIED',
        openedAt: opts.closedAt,
        closedAt: opts.closedAt,
        repeatFailure: !firstTime,
        slaAccumulatedPauseSeconds: 0n,
      },
    });
    cycleIds.push(cycle.cycleId);
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'CLOSED',
        closureType: opts.closureType,
        deviceId,
        failureCycleId: cycle.cycleId,
        plantId: opts.plantId ?? plantA,
        companyId,
        companyTier: 'GOLD',
        closedAt: opts.closedAt,
        lastStateChangedAt: opts.closedAt,
      },
    });
    ticketIds.push(ticket.ticketId);

    // The assignment leg of the attribution — the only one a departure has.
    await prisma.batchAssignmentTicket.create({
      data: { batchId: batchBySe.get(seId)!, ticketId: ticket.ticketId, sortOrder: 1 },
    });

    if (repair) {
      const submittedAt = new Date(opts.closedAt.getTime() - 3_600_000);
      await prisma.troubleshootingSubmission.create({
        data: {
          ticketId: ticket.ticketId,
          failureCycleId: cycle.cycleId,
          submissionType: 'TROUBLESHOOTING_FORM',
          clientSubmissionId: randomUUID(),
          seId,
          presenceSource: 'NONE',
          rootCauseCategory: 'POWER_ISSUE',
          submittedAt,
        },
      });
      if (opts.onsiteToSubmitSeconds !== undefined) {
        await prisma.softState.create({
          data: {
            ticketId: ticket.ticketId,
            seId,
            type: 'ON_SITE',
            setAt: new Date(submittedAt.getTime() - opts.onsiteToSubmitSeconds * 1000),
          },
        });
      }
      if (opts.verification !== null && opts.verification !== undefined) {
        await prisma.verificationRun.create({
          data: {
            ticketId: ticket.ticketId,
            deviceId,
            startedAt: submittedAt,
            outcome: opts.verification,
            outcomeAt: opts.closedAt,
          },
        });
      }
    }
    return ticket.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new ReportsService(prisma);

    zoneA = (await prisma.zone.create({ data: { name: 'Z-sep-A-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z-sep-B-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-sep-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'P-sep-A-' + NS, zoneId: zoneA } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'P-sep-B-' + NS, zoneId: zoneB } })).plantId;
    deviceId = String(9_392_000n + BigInt(NS % 1000));
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });

    seRamesh = await makeSe('A Ramesh ' + NS, 'DEDICATED', zoneA, plantA);
    seManoj = await makeSe('B Manoj ' + NS, 'FLOATING', zoneA, plantA);
    seIdle = await makeSe('C Idle ' + NS, 'DEDICATED', zoneA, plantA);
    seOther = await makeSe('Z Other ' + NS, 'MULTI_PLANT', zoneB, plantB);

    // A Ramesh — 12 repairs (9 first-time, 3 not) + 3 departures. Verifications: 11 CLOSED, 1 FAILED.
    // Stage time: two pairs, 3600s and 5400s → 4500s average.
    for (let i = 0; i < 12; i++) {
      await closeTicket(seRamesh, {
        closureType: null,
        closedAt: JUNE(2 + i),
        firstTime: i < 9,
        verification: i === 11 ? 'FAILED_VERIFICATION' : 'CLOSED',
        onsiteToSubmitSeconds: i === 0 ? 3600 : i === 1 ? 5400 : undefined,
      });
    }
    for (let i = 0; i < 3; i++) {
      await closeTicket(seRamesh, { closureType: 'DEVICE_UNDEPLOYED_CLOSE', closedAt: JUNE(20 + i) });
    }

    // B Manoj — 4 repairs + 2 departures = 6 closures, under the floor. Two of the four are in the
    // 15–21 June week, so the weekly window has a different (still-suppressed) shape.
    await closeTicket(seManoj, { closureType: null, closedAt: JUNE(3), verification: 'CLOSED' });
    await closeTicket(seManoj, { closureType: null, closedAt: JUNE(4), verification: 'FAILED_VERIFICATION' });
    await closeTicket(seManoj, { closureType: null, closedAt: JUNE(16), verification: 'CLOSED' });
    await closeTicket(seManoj, { closureType: null, closedAt: JUNE(17), verification: 'CLOSED' });
    await closeTicket(seManoj, { closureType: 'DEVICE_UNDEPLOYED_CLOSE', closedAt: JUNE(5) });
    await closeTicket(seManoj, { closureType: 'DEVICE_UNDEPLOYED_CLOSE', closedAt: JUNE(18) });

    // Z Other, in zone B — the clamp's target.
    await closeTicket(seOther, { closureType: null, closedAt: JUNE(6), plantId: plantB, verification: 'CLOSED' });

    // Out of window: May, and July. Neither may reach the June report.
    await closeTicket(seRamesh, { closureType: null, closedAt: new Date(Date.UTC(2026, 4, 20)), verification: 'CLOSED' });
    await closeTicket(seRamesh, { closureType: null, closedAt: new Date(Date.UTC(2026, 6, 2)), verification: 'CLOSED' });
  });

  afterAll(async () => {
    await prisma.verificationRun.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { scheduleId: { in: scheduleIds } } });
    await prisma.workSchedule.deleteMany({ where: { scheduleId: { in: scheduleIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  /** Zone A only, so other suites' engineers cannot join the roster and move the totals. */
  const zoneAReport = () => service.seProductivity(OH, { month: MONTH_PARAM, zoneId: Number(zoneA) });
  const rowFor = (report: SeProductivityReport, seId: string): SeProductivityRow | undefined =>
    report.rows.find((r) => r.seId === seId);

  it('splits closures into repairs and departures — the F7 prerequisite, on the page itself', async () => {
    const report = await zoneAReport();
    const ramesh = rowFor(report, seRamesh);
    expect(ramesh?.repairClosures).toBe(12);
    expect(ramesh?.departureClosures).toBe(3);
    expect(ramesh?.closures).toBe(15);
    // The whole point: the departures are visible and are NOT credited as repairs.
    expect(ramesh?.repairClosures).not.toBe(ramesh?.closures);
  });

  it('derives first-time-fix, failed-verification and average on-site → submission', async () => {
    const ramesh = rowFor(await zoneAReport(), seRamesh);
    // 9 first-time fixes over 12 repair closures — the departures are not in the denominator.
    expect(ramesh?.firstTimeFixes).toBe(9);
    expect(ramesh?.firstTimeFixRatePct).toBe(75);
    // 1 failed of 12 decided runs.
    expect(ramesh?.verificationsDecided).toBe(12);
    expect(ramesh?.failedVerifications).toBe(1);
    expect(ramesh?.failedVerificationRatePct).toBe(8.33);
    // 3600s and 5400s → 4500s over 2 pairs.
    expect(ramesh?.onsiteToSubmissionCount).toBe(2);
    expect(ramesh?.avgOnsiteToSubmissionSeconds).toBe(4500);
  });

  /**
   * The operator constraint attached to the approved design. Enforced in the service rather than the
   * page, so a CSV export cannot carry the number the page refuses to draw.
   */
  describe('the small-sample floor', () => {
    it('withholds every rate below the floor while showing every count', async () => {
      const manoj = rowFor(await zoneAReport(), seManoj);
      expect(manoj?.closures).toBe(6);
      expect(manoj?.closures).toBeLessThan(SE_PRODUCTIVITY_RATE_MIN_SAMPLE);
      expect(manoj?.ratesSuppressed).toBe(true);
      expect(manoj?.firstTimeFixRatePct).toBeNull();
      expect(manoj?.failedVerificationRatePct).toBeNull();
      // Counts are facts about the jobs that happened and are never withheld.
      expect(manoj?.repairClosures).toBe(4);
      expect(manoj?.departureClosures).toBe(2);
      expect(manoj?.firstTimeFixes).toBe(4);
      expect(manoj?.failedVerifications).toBe(1);
    });

    it('does not suppress the full-sample engineer, and states the threshold in the payload', async () => {
      const report = await zoneAReport();
      expect(report.rateMinSample).toBe(SE_PRODUCTIVITY_RATE_MIN_SAMPLE);
      expect(rowFor(report, seRamesh)?.ratesSuppressed).toBe(false);
    });
  });

  it('keeps an engineer who closed nothing on the roster, with null rates and zero counts', async () => {
    const idle = rowFor(await zoneAReport(), seIdle);
    expect(idle).toBeDefined();
    expect(idle?.closures).toBe(0);
    expect(idle?.repairClosures).toBe(0);
    expect(idle?.firstTimeFixRatePct).toBeNull();
    expect(idle?.avgOnsiteToSubmissionSeconds).toBeNull();
  });

  it('orders by name and never by a metric — this is not a league table', async () => {
    const report = await zoneAReport();
    expect(report.rows.map((r) => r.seId)).toEqual([seRamesh, seManoj, seIdle]);
    // The worst first-time-fix rate is not first, and the best is not first either — only the name is.
    expect(report.rows.map((r) => r.name)).toEqual([...report.rows.map((r) => r.name)].sort());
  });

  it('reports the window, the totals and the coverage type each row belongs to', async () => {
    const report = await zoneAReport();
    expect(report.granularity).toBe('monthly');
    expect(report.from).toBe('2026-06-01');
    expect(report.to).toBe('2026-06-30');
    expect(report.totals).toEqual({ engineers: 3, closures: 21, repairClosures: 16, departureClosures: 5 });
    expect(rowFor(report, seManoj)?.coverageType).toBe('FLOATING');
    expect(rowFor(report, seRamesh)?.coverageType).toBe('DEDICATED');
    expect(report.dataAsOf).not.toBeNull();
  });

  it('excludes closures outside the window', async () => {
    // Ramesh has one May and one July repair closure in the fixture; June must not see either.
    const june = rowFor(await zoneAReport(), seRamesh);
    expect(june?.repairClosures).toBe(12);
    const may = rowFor(await service.seProductivity(OH, { month: '2026-05', zoneId: Number(zoneA) }), seRamesh);
    expect(may?.repairClosures).toBe(1);
  });

  it('resolves a weekly window to the Monday of the week containing weekOf', async () => {
    const report = await service.seProductivity(OH, { granularity: 'weekly', weekOf: WEEK_OF, zoneId: Number(zoneA) });
    expect(report.granularity).toBe('weekly');
    expect(report.from).toBe('2026-06-15'); // the Monday, not the Wednesday asked for
    expect(report.to).toBe('2026-06-21');
    // Of Manoj's six June closures, three fall in that week (16th, 17th, 18th).
    const manoj = rowFor(report, seManoj);
    expect(manoj?.repairClosures).toBe(2);
    expect(manoj?.departureClosures).toBe(1);
  });

  it('filters the roster by coverage type', async () => {
    const floating = await service.seProductivity(OH, { month: MONTH_PARAM, zoneId: Number(zoneA), coverage: 'FLOATING' });
    expect(floating.rows.map((r) => r.seId)).toEqual([seManoj]);
    expect(floating.filters.coverage).toBe('FLOATING');
  });

  /**
   * The clamp is the enforcement; the dropdown is a convenience. A ZM asking for zone B gets zone A,
   * and `filters.zoneId` echoes zone A so the page's scope chip can say the request was overridden
   * instead of labelling zone B's heading over zone A's numbers.
   */
  it('clamps a ZM to their own zone even when they ask for another', async () => {
    const zm = { role: 'ZONAL_MANAGER', zoneId: Number(zoneA) };
    const report = await service.seProductivity(zm, { month: MONTH_PARAM, zoneId: Number(zoneB) });
    expect(report.filters.zoneId).toBe(Number(zoneA));
    expect(report.rows.map((r) => r.seId)).not.toContain(seOther);
    expect(report.rows.map((r) => r.seId)).toContain(seRamesh);
  });

  it('lets an Operations Head read another zone', async () => {
    const report = await service.seProductivity(OH, { month: MONTH_PARAM, zoneId: Number(zoneB) });
    expect(report.rows.map((r) => r.seId)).toEqual([seOther]);
    expect(report.filters.zoneId).toBe(Number(zoneB));
  });
});
