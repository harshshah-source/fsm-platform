import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * #266 slice 1 — the score decides which SE wins inside the coverage tier, and the Plant Cluster
 * Multiplier is what makes two candidates score differently at all.
 *
 * **What was wrong.** `chosen = planner ?? passed[0]` — strict precedence then `se_id` ascending. The
 * score was computed once, *after* the winner was already picked, for that winner alone. Every
 * `priority_rule_config` weight was therefore decorative with respect to selection, and the admin
 * weights page offered levers that moved nothing.
 *
 * **Why clustering had to land in the same slice (#258 Q-A).** Scoring every candidate is not by
 * itself enough to make the score selective, and reading the code is what shows it: `features` is
 * built entirely from the *ticket* — `companyPriorityRank`, `dispatchUrgency`, `repeatFailure`,
 * `inactivityHours` — and `distanceFromPrevStopKm` is hardcoded `null` until #267. So every candidate
 * for a given ticket computes an **identical** `baseScore`, and no weight change can reorder them.
 * The cluster multiplier is the only per-candidate term this slice can produce, which is exactly what
 * the pre-implementation review meant by "it could not otherwise influence any decision".
 *
 * That also makes the issue's AC-2 ("a weight change flips the winner") unbuildable as written —
 * raising a weight scales every candidate's base by the same factor. Recorded in the issue and proven
 * here in the only form today's feature set allows: the *setting* that genuinely discriminates is
 * `plant_cluster_multiplier`, and driving it to 1.0 must hand the ticket back to the `se_id` winner.
 * That is a stronger test than the one asked for, because it fails if clustering is cosmetic.
 *
 * **The multiplier is applied to a floored base** (operator-ruled). `score = baseScore * multiplier`
 * inverts when `baseScore` is negative: with the seeded DEFICIT weights an install-backlog ticket has
 * `dispatchUrgency = 0` by design, so a repeat-failure ticket for a company at rank F scores exactly
 * 0 (the bonus is a no-op) and at rank G or below scores negative — where a 1.25x "bonus" makes the SE
 * already going to that plant score **worse** than one who has never been. `company_priority_rank` is
 * a free `String` column, not an enum, so those letters are reachable today.
 */
const NS = Date.now();
const NOW = new Date('2026-08-05T06:00:00Z');
const DAY = new Date('2026-08-05T00:00:00Z');

describe('#266 — the score selects the SE within the coverage tier', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  /** `seLow` sorts before `seHigh`, so today's `passed[0]` rule always picks `seLow`. */
  let seLow: string;
  let seHigh: string;

  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  let subjectTicket: string;

  const setClusterMultiplier = (value: number) =>
    prisma.systemSetting.upsert({
      where: { key: 'plant_cluster_multiplier' },
      create: { key: 'plant_cluster_multiplier', value },
      update: { value },
    });

  const makeSe = async (label: string, coverageType: 'DEDICATED' | 'FLOATING'): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: `SE ${label}`, role: 'SERVICE_ENGINEER', phone: `ph-${tag}`, email: `${tag}@sc.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType, zoneId, dailyCapacity: 10 },
    });
    if (coverageType === 'DEDICATED') {
      await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType } });
    }
    return u.userId;
  };

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(26_600_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 180 * 60_000),
        plantId,
        companyId,
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
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  /**
   * Give `se` a live, already-committed stop at the plant for the target day — the shape
   * `committedDayLoad` already counts, which is precisely why Q-A seeds the plant set from it rather
   * than inventing a second notion of "where is this engineer going today".
   */
  const giveExistingStopAtPlant = async (se: string): Promise<void> => {
    const schedule = await prisma.workSchedule.create({
      data: { seId: se, zoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', dispatchedAt: NOW },
    });
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId: se, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    const ticketId = await makeTicket();
    await prisma.ticket.update({ where: { ticketId }, data: { assignmentState: 'FORMALLY_ASSIGNED' } });
    await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId, sortOrder: 1 } });
  };

  const winnerOf = async (ticketId: string): Promise<string | null> => {
    const summary = await rec.runForZone(zoneId, { now: NOW, dryRun: true, targetDate: NOW });
    return summary.projection?.decisions.find((d) => d.ticketId === ticketId)?.seId ?? null;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));

    for (const [component, weight] of [
      ['company_priority_rank', 0.4],
      ['dispatch_urgency', 0.3],
      ['repeat_failure_penalty', 0.2],
      ['distance', 0.1],
    ] as const) {
      await prisma.priorityRuleConfig.upsert({
        where: { weightSetRef_component: { weightSetRef: 'v1', component } },
        create: { weightSetRef: 'v1', component, weight, active: true },
        update: { weight, active: true },
      });
    }
    await setClusterMultiplier(1.25);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-sc-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-sc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-sc-' + NS, zoneId } })).plantId;

    const a = await makeSe('one', 'DEDICATED');
    const b = await makeSe('two', 'DEDICATED');
    [seLow, seHigh] = [a, b].sort();

    // The higher-`se_id` SE is the one already going to the plant, so clustering and the old
    // `passed[0]` rule point at *different* engineers. If they agreed, the test could not tell which
    // rule produced the answer.
    await giveExistingStopAtPlant(seHigh);
    subjectTicket = await makeTicket();
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
    await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('AC Q-A — the SE already holding a stop at the plant wins over the lower `se_id`', async () => {
    // The whole point of the slice in one assertion. Both candidates are DEDICATED at this plant and
    // pass every hard filter, so under the old rule the winner was decided by `se_id` alone and this
    // returns `seLow`. Clustering is the first thing that has ever made two candidates for the same
    // ticket score differently.
    await setClusterMultiplier(1.25);
    expect(await winnerOf(subjectTicket)).toBe(seHigh);
  });

  it('AC Q-A — a multiplier of 1.0 hands the ticket back to the `se_id` winner', async () => {
    // Proves the factor is load-bearing rather than cosmetic, and doubles as the deterministic
    // tie-break pin: with clustering neutralised the two candidates score *identically*, and the
    // winner must then be `se_id` ascending rather than whichever row the database returned first.
    await setClusterMultiplier(1.0);
    expect(await winnerOf(subjectTicket)).toBe(seLow);
    await setClusterMultiplier(1.25);
  });

  it('AC — precedence is inviolable: a FLOATING SE holding the plant loses to a DEDICATED one', async () => {
    // Clustering must never promote a lower tier, and must never drop a candidate — it is a score
    // term, not a filter. The floating SE has both the cluster bonus and, here, the lower `se_id`
    // tie-break going for them, and still cannot win: the winning tier is chosen first, and the score
    // only ranks *within* it.
    const floating = await makeSe('floating', 'FLOATING');
    await prisma.engineerTerritoryCoverage.create({ data: { seId: floating, zoneId } }).catch(() => undefined);
    await giveExistingStopAtPlant(floating);

    const winner = await winnerOf(subjectTicket);
    expect(winner).not.toBe(floating);
    expect([seLow, seHigh]).toContain(winner);
  });
});
