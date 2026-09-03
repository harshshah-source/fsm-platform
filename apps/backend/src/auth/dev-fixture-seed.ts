import type { PrismaClient } from '../generated/prisma/client';
import { FIXTURE_EMAILS } from './auth-fixture-seed';
import { readDevFixtureConfig } from './dev-fixture-seed.config';

/**
 * Walkable dev fixtures — the seeder (#336).
 *
 * `runDevSeed` mints the `*@fsm.test` logins and stops there, by design. That leaves the Service
 * Engineer account able to authenticate and unable to do anything: with no `engineer_master` row
 * every SE-facing route 404s, `/me/tickets` returns nothing, and the SE half of `vouchers`,
 * `inventory` and `scheduling` cannot be exercised at all. The 2026-09-02 module-gap survey left 17
 * findings unresolved for exactly this reason — for want of data, not for want of looking.
 *
 * This is the opt-in that closes that, and it is deliberately a **separate** entrypoint from the
 * login seeder rather than a step inside it. See `dev-fixture-seed.config.ts` for why the second flag
 * exists; the short version is that the dev database is an ingested mirror of production and an
 * operator reading its engineer directory must not find rows a seeder invented unless they asked for
 * them.
 *
 * Idempotent by construction: every write is guarded by a read, and the summary reports what was
 * actually created so a re-run can honestly print "nothing to do".
 */

/** The narrow slice of the client this seeder touches — a Prisma transaction client satisfies it,
 *  which is what lets the e2e prove creation-from-empty without mutating the shared `fsm_test`
 *  database (#156). */
export type DevWalkFixtureClient = Pick<
  PrismaClient,
  | 'user'
  | 'plant'
  | 'engineerMaster'
  | 'seCoverage'
  | 'commonKitDefinition'
  | 'seVanStock'
  | 'leaveRequest'
  | 'ticket'
  | 'companyTierOverride'
  | 'verificationRun'
>;

export interface DevWalkFixtureSummary {
  /** `engineer_master` rows created (0 on a re-run). */
  engineer: number;
  /** `se_coverage` rows created (0 on a re-run). */
  coverage: number;
  /** `se_van_stock` rows created (0 on a re-run). */
  vanStock: number;
  /** `leave_requests` rows created (0 on a re-run). */
  leaveRequest: number;
  /** `company_tier_overrides` rows created, and the ticket snapshot re-stamped with them (0 on a
   *  re-run, and 0 when the database holds no ticket old enough to qualify). */
  tierOverride: number;
  /** `verification_runs` rows created (0 on a re-run, and 0 when there are no tickets to hang them
   *  off). The module holds zero rows in every environment surveyed, which is why V-01 and V-02 could
   *  only ever be read in source. */
  verificationRuns: number;
}

/**
 * The engineer's capacity and coverage shape.
 *
 * DEDICATED with a single covered plant is the simplest walkable arrangement: one plant's tickets
 * reach this SE, and the recommender's coverage-tier precedence has an unambiguous answer. Capacity 5
 * is a working day's worth of stops — high enough that a walk is not immediately capacity-blocked,
 * low enough that the capacity constraint itself can still be demonstrated.
 */
const FIXTURE_DAILY_CAPACITY = 5;

export async function seedDevWalkFixtures(
  client: DevWalkFixtureClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DevWalkFixtureSummary> {
  const config = readDevFixtureConfig(env);
  if (!config.allowed) throw new Error(config.reason);

  // Resolved from the fixture list rather than from a UUID repeated here: a second definition of
  // "the dev accounts" is how the seeder and the login seeder start disagreeing about who exists.
  const se = await client.user.findFirst({
    where: { email: { in: [...FIXTURE_EMAILS] }, role: 'SERVICE_ENGINEER' },
    select: { userId: true, zoneId: true, email: true },
  });

  if (!se) {
    throw new Error(
      'Refusing to seed walkable dev fixtures: no fixture Service Engineer exists. These fixtures ' +
        'hang off the seeded login, so the order matters — run `npm run seed` then `npm run seed:dev` ' +
        'first (migrate → seed → seed:dev → seed:dev-fixtures).',
    );
  }

  if (se.zoneId === null) {
    throw new Error(
      `Refusing to seed walkable dev fixtures: ${se.email} has no zone. An engineer row inherits the ` +
        'zone of its user row, and a null-zone engineer authenticates and then 403s everywhere — the ' +
        'harder defect to diagnose. Re-run `npm run seed` so the zones exist, then `npm run seed:dev`.',
    );
  }

  const summary: DevWalkFixtureSummary = {
    engineer: 0,
    coverage: 0,
    vanStock: 0,
    leaveRequest: 0,
    tierOverride: 0,
    verificationRuns: 0,
  };

  // Read-then-write rather than an upsert, so the summary can distinguish "created" from "already
  // there" — that difference is the whole of the idempotence claim.
  const engineer = await client.engineerMaster.findUnique({ where: { engineerId: se.userId } });
  if (!engineer) {
    await client.engineerMaster.create({
      data: {
        engineerId: se.userId,
        coverageType: 'DEDICATED',
        zoneId: se.zoneId,
        dailyCapacity: FIXTURE_DAILY_CAPACITY,
        isActive: true,
      },
    });
    summary.engineer = 1;
  }

  const covered = await client.seCoverage.findFirst({ where: { seId: se.userId } });
  if (!covered) {
    // The engineer's own zone, deliberately: coverage pointing out of zone is the #215 re-zoning
    // defect in another shape, and the recommender would never surface this SE for it. Lowest plant
    // id so a re-seeded database picks the same plant twice.
    const plant = await client.plant.findFirst({
      where: { zoneId: se.zoneId },
      orderBy: { plantId: 'asc' },
      select: { plantId: true },
    });

    if (!plant) {
      throw new Error(
        `Refusing to seed walkable dev fixtures: zone ${se.zoneId} holds no plants, so there is ` +
          'nothing for the engineer to cover. Run the ingestion sync (or `npm run seed`) so the ' +
          'plant mirror is populated first.',
      );
    }

    await client.seCoverage.create({
      data: { seId: se.userId, plantId: plant.plantId, coverageType: 'DEDICATED' },
    });
    summary.coverage = 1;
  }

  // Van stock: the common kit MINUS ONE item, deliberately.
  //
  // A fully-stocked van is what the survey actually found (an empty `se_van_stock` reads as complete,
  // because `commonKitStatus` compares against nothing), and it makes the Common-Kit hard filter
  // impossible to exercise: the SE is never dropped from a Day Plan, `component_blocked_queue` never
  // fills, and INV-G8's consequences stay invisible. Carrying everything but one item is the smallest
  // state in which "kit short" is a real, reachable answer.
  const kit = await client.commonKitDefinition.findMany({
    where: { active: true },
    orderBy: { componentId: 'asc' },
    select: { componentId: true, minQty: true },
  });

  if (kit.length > 1 && (await client.seVanStock.count({ where: { seId: se.userId } })) === 0) {
    // The highest component id is the one left out, so a re-seeded database is short of the same
    // item every time and a walk written against this fixture keeps meaning what it meant.
    for (const item of kit.slice(0, -1)) {
      await client.seVanStock.create({
        data: { seId: se.userId, componentId: item.componentId, qty: item.minQty },
      });
      summary.vanStock += 1;
    }
  }

  // A pending leave request, forward-dated: the manager queue needs a row to act on, and a window
  // already in the past is one neither a manager nor the recommender would ever consult.
  if ((await client.leaveRequest.count({ where: { seId: se.userId } })) === 0) {
    const windowStart = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const windowEnd = new Date(windowStart.getTime() + 24 * 60 * 60 * 1000);

    await client.leaveRequest.create({
      data: {
        seId: se.userId,
        type: 'ON_LEAVE',
        status: 'PENDING',
        windowStart,
        windowEnd,
        reason: 'Dev fixture (#336) — a pending request so the leave queue has something to decide.',
      },
    });
    summary.leaveRequest = 1;
  }

  // A Platinum case, raised the way the product says a scoped tier change is raised: a zone-scoped,
  // expiring, reasoned `company_tier_overrides` row (#157). Deliberately NOT `companies.company_tier`
  // — that is Operations-Head-owned and global, so re-tiering there would change how every zone and
  // every report treats a real company, to manufacture one fixture.
  //
  // The ticket's own `companyTier` snapshot is re-stamped to match, because that is what the Platinum
  // sweep actually filters on (`cross-zone/cross-zone-escalation.service.ts:77`), not the effective
  // tier. A ticket raised while an override is in force would carry PLATINUM anyway; without the
  // stamp this would be a Platinum case the Platinum sweep cannot see.
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  const candidate = await client.ticket.findFirst({
    where: {
      status: 'OPEN',
      assignmentState: 'UNASSIGNED',
      createdAt: { lt: new Date(Date.now() - FOUR_HOURS_MS) },
      plant: { zoneId: se.zoneId },
    },
    orderBy: { createdAt: 'asc' },
    select: { ticketId: true, companyId: true },
  });

  if (candidate) {
    const existingOverride = await client.companyTierOverride.findFirst({
      where: {
        companyId: candidate.companyId,
        zoneId: se.zoneId,
        status: 'ACTIVE',
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });

    if (!existingOverride) {
      // Thirty days: inside #157's two-month ceiling, and long enough that a developer's dev database
      // does not silently stop being walkable halfway through a slice.
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      await client.companyTierOverride.create({
        data: {
          companyId: candidate.companyId,
          zoneId: se.zoneId,
          tier: 'PLATINUM',
          reason:
            'Dev fixture (#336) — a scoped, expiring Platinum case so cross-zone auto-escalation and ' +
            'tier precedence can be walked. Expires on its own; cancel it to revert.',
          expiresAt,
        },
      });
      await client.ticket.update({
        where: { ticketId: candidate.ticketId },
        data: { companyTier: 'PLATINUM' },
      });
      summary.tierOverride = 1;
    }
  }

  // Three verification runs. The module holds ZERO rows in every environment the survey looked at, so
  // its zone clamp, its fraud list and its ledger agreement have only ever been read in source —
  // V-01 and V-02 are `needs-verify` for want of these three rows and nothing else.
  //
  // The shapes are chosen to be the ones those findings act on:
  //   1. FAILED_VERIFICATION with zero pings — what the survey called `FAILED_NO_PINGS`, which is not
  //      an outcome in this schema. This is the row `markAutoRecovery` leaves with a stale verdict.
  //   2. fraudFlag, placed OUTSIDE the fixture SE's zone where the database allows it — the fraud-flag
  //      read declares no zone scope, and a same-zone row cannot demonstrate that.
  //   3. CLOSED — the control, so "every run is a failure" is not mistaken for the clamp working.
  // Guarded on the module being empty, not on the chosen tickets being unused: "a ticket with no run
  // yet" is true of a different ticket every time, so that guard would hand a second run three more
  // rows. This fixture exists to populate a module that holds zero rows; once it holds any, it is not
  // this seeder's business.
  const runnable =
    (await client.verificationRun.count()) === 0
      ? await client.ticket.findMany({
          orderBy: { createdAt: 'asc' },
          select: { ticketId: true, deviceId: true, plant: { select: { zoneId: true } } },
          take: 50,
        })
      : [];

  const homeZoneTickets = runnable.filter((t) => t.plant.zoneId === se.zoneId);
  const foreignZoneTickets = runnable.filter((t) => t.plant.zoneId !== se.zoneId);

  // The fraud row gets first claim on a foreign-zone ticket, because it is the only one of the three
  // whose zone is load-bearing. Everything else falls back to whatever is left.
  const fraudTicket = foreignZoneTickets[0] ?? homeZoneTickets[0];
  const remaining = runnable.filter((t) => t.ticketId !== fraudTicket?.ticketId);
  const noPingsTicket = remaining.find((t) => t.plant.zoneId === se.zoneId) ?? remaining[0];
  const closedTicket = remaining.find(
    (t) => t.ticketId !== noPingsTicket?.ticketId && t.plant.zoneId === se.zoneId,
  ) ?? remaining.find((t) => t.ticketId !== noPingsTicket?.ticketId);

  const startedAt = new Date(Date.now() - 60 * 60 * 1000);
  const runs: { ticket: (typeof runnable)[number] | undefined; data: Record<string, unknown> }[] = [
    {
      ticket: noPingsTicket,
      data: { phase: 'PENDING', outcome: 'FAILED_VERIFICATION', pingsReceivedCount: 0, fraudFlag: false },
    },
    {
      // Pings DID arrive — that is what makes this fraud rather than silence. The flag is raised when
      // the first ping lands far from the GPS the engineer submitted from, so a fraud row with zero
      // pings would be incoherent: there would be nothing to be suspicious of.
      ticket: fraudTicket,
      data: {
        phase: 'PHASE_1_PASS',
        outcome: 'FAILED_VERIFICATION',
        pingsReceivedCount: 4,
        firstPingDistanceMeters: 8_400,
        fraudFlag: true,
      },
    },
    {
      ticket: closedTicket,
      data: { phase: 'PHASE_2_PASS', outcome: 'CLOSED', pingsReceivedCount: 12, fraudFlag: false },
    },
  ];

  for (const run of runs) {
    if (!run.ticket) continue;
    await client.verificationRun.create({
      data: {
        ticketId: run.ticket.ticketId,
        deviceId: run.ticket.deviceId,
        startedAt,
        outcomeAt: startedAt,
        ...run.data,
      },
    });
    summary.verificationRuns += 1;
  }

  return summary;
}
