import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { seedDevWalkFixtures } from '../src/auth/dev-fixture-seed';
import { PrismaService } from '../src/prisma/prisma.service';
import { SHARED_AUTH_SE_ID } from './fixtures/shared-auth-se';

/**
 * #336 — the walkable-state dev fixtures against a real database.
 *
 * The pure guard lives in `dev-fixture-seed.spec.ts`; this file covers what only a database can show.
 *
 * Every case runs inside a transaction that is deliberately rolled back. The suite shares one
 * long-lived `fsm_test` database that is never truncated between files (#156), and this seeder writes
 * rows other specs are sensitive to — an `engineer_master` row for the shared auth SE (whose zone
 * #215 pinned), `se_coverage` (whose DEDICATED partial-unique #255 fought), and a re-tiered company.
 * Letting any of that survive the file would hand the next spec a database it did not ask for. The
 * `$transaction` callback throws after asserting, so the seeder's writes and our deletes vanish
 * together.
 *
 * Note the shared SE already HAS an `engineer_master` row in `fsm_test` — `seedSharedAuthSeEngineer`
 * writes it in global setup, before any spec runs. That is the test database's answer to the same
 * problem and it stays. Proving creation therefore means deleting it inside the transaction first,
 * exactly as `dev-seed.e2e-spec.ts` does for the credential rows.
 */
describe('#336 walkable dev fixtures (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const ALLOWED_ENV = { SEED_DEV_WALK_FIXTURES: 'true', NODE_ENV: 'test' };

  /**
   * `fsm_test` is truncated and org-seeded, so it holds no tickets at all. Anything that asserts on
   * ticket-derived fixtures has to supply them, or it passes vacuously — which is the trap the
   * idempotence case fell into first: with no tickets, "created 0 runs twice" was true whatever the
   * guard did. Spread over two zones where the reference data offers a second one, so the fraud row
   * has somewhere out-of-zone to land.
   */
  const makeTickets = async (
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    count: number,
  ): Promise<void> => {
    const company = await tx.company.findFirstOrThrow({ select: { companyId: true } });
    const plants = await tx.plant.findMany({
      orderBy: { plantId: 'asc' },
      select: { plantId: true, zoneId: true },
      take: 50,
    });
    const se = await tx.user.findUniqueOrThrow({
      where: { userId: SHARED_AUTH_SE_ID },
      select: { zoneId: true },
    });
    const home = plants.find((p) => p.zoneId === se.zoneId) ?? plants[0]!;
    const foreign = plants.find((p) => p.zoneId !== se.zoneId) ?? home;

    for (let i = 0; i < count; i++) {
      const deviceId = `dev-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${i}`;
      await tx.device.create({ data: { deviceId } });
      const cycle = await tx.failureCycle.create({
        data: { deviceId, state: 'OPEN', openedAt: new Date() },
      });
      await tx.ticket.create({
        data: {
          workType: 'TROUBLESHOOT',
          status: 'OPEN',
          failureCycleId: cycle.cycleId,
          deviceId,
          // The last one goes out of zone; the rest stay home.
          plantId: i === count - 1 ? foreign.plantId : home.plantId,
          companyId: company.companyId,
          companyTier: 'GOLD',
          assignmentState: 'UNASSIGNED',
          lastStateChangedAt: new Date(),
        },
      });
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses to touch the database at all when its own opt-in is absent', async () => {
    await expect(seedDevWalkFixtures(prisma, { ALLOW_DEV_SEED: 'true' })).rejects.toThrow(
      /SEED_DEV_WALK_FIXTURES/,
    );
  });

  it('gives the Service-Engineer login an engineer row and coverage it did not have', async () => {
    const ROLLBACK = new Error('rollback');

    const observed = await prisma
      .$transaction(async (tx) => {
        // The state the survey actually found on the dev database: a `users` row and nothing else.
        await tx.seCoverage.deleteMany({ where: { seId: SHARED_AUTH_SE_ID } });
        await tx.engineerMaster.deleteMany({ where: { engineerId: SHARED_AUTH_SE_ID } });
        expect(await tx.engineerMaster.findUnique({ where: { engineerId: SHARED_AUTH_SE_ID } })).toBeNull();

        await seedDevWalkFixtures(tx as unknown as PrismaService, ALLOWED_ENV);

        const engineer = await tx.engineerMaster.findUnique({ where: { engineerId: SHARED_AUTH_SE_ID } });
        const coverage = await tx.seCoverage.findMany({ where: { seId: SHARED_AUTH_SE_ID } });
        const plant =
          coverage.length > 0
            ? await tx.plant.findUnique({ where: { plantId: coverage[0]!.plantId }, select: { zoneId: true } })
            : null;

        throw Object.assign(ROLLBACK, { observed: { engineer, coverage, plant } });
      })
      .catch((err: unknown) => {
        if (err === ROLLBACK) return (err as { observed: Record<string, unknown> }).observed;
        throw err;
      });

    const { engineer, coverage, plant } = observed as {
      engineer: { zoneId: bigint | null; dailyCapacity: number; isActive: boolean; coverageType: string } | null;
      coverage: { plantId: bigint }[];
      plant: { zoneId: bigint | null } | null;
    };

    expect(engineer).not.toBeNull();
    expect(engineer!.coverageType).toBe('DEDICATED');
    expect(engineer!.dailyCapacity).toBe(5);
    expect(engineer!.isActive).toBe(true);

    // Exactly one coverage row, and on a plant in the engineer's own zone — a coverage row pointing
    // out of zone is the #215 defect wearing different clothes, and the recommender would never
    // surface the SE for it.
    expect(coverage).toHaveLength(1);
    expect(plant).not.toBeNull();
    expect(plant!.zoneId).toBe(engineer!.zoneId);
  });

  it('stocks the van with the common kit minus exactly one item, so a kit-short walk is possible', async () => {
    const ROLLBACK = new Error('rollback');

    const observed = await prisma
      .$transaction(async (tx) => {
        await tx.seVanStock.deleteMany({ where: { seId: SHARED_AUTH_SE_ID } });
        await seedDevWalkFixtures(tx as unknown as PrismaService, ALLOWED_ENV);

        const kit = await tx.commonKitDefinition.findMany({ where: { active: true } });
        const stock = await tx.seVanStock.findMany({ where: { seId: SHARED_AUTH_SE_ID } });

        throw Object.assign(ROLLBACK, { observed: { kit, stock } });
      })
      .catch((err: unknown) => {
        if (err === ROLLBACK) return (err as { observed: Record<string, unknown> }).observed;
        throw err;
      });

    const { kit, stock } = observed as {
      kit: { componentId: bigint; minQty: number }[];
      stock: { componentId: bigint; qty: number }[];
    };

    // The whole point of "minus one" is that `commonKitStatus` reports incomplete: a fully-stocked
    // van makes the Common-Kit hard filter untestable, which is the state the survey found.
    expect(kit.length).toBeGreaterThan(0);
    expect(stock).toHaveLength(kit.length - 1);

    const stocked = new Map(stock.map((s) => [String(s.componentId), s.qty]));
    const missing = kit.filter((k) => !stocked.has(String(k.componentId)));
    expect(missing).toHaveLength(1);
    // Every item it does carry must actually satisfy the kit minimum, or the SE is short of two
    // things and the fixture no longer says what it claims.
    for (const item of kit.filter((k) => stocked.has(String(k.componentId)))) {
      expect(stocked.get(String(item.componentId))).toBeGreaterThanOrEqual(item.minQty);
    }
  });

  it('leaves one PENDING leave request for the manager queue to act on', async () => {
    const ROLLBACK = new Error('rollback');

    const observed = await prisma
      .$transaction(async (tx) => {
        await tx.leaveRequest.deleteMany({ where: { seId: SHARED_AUTH_SE_ID } });
        await seedDevWalkFixtures(tx as unknown as PrismaService, ALLOWED_ENV);
        const rows = await tx.leaveRequest.findMany({ where: { seId: SHARED_AUTH_SE_ID } });
        throw Object.assign(ROLLBACK, { observed: rows });
      })
      .catch((err: unknown) => {
        if (err === ROLLBACK) return (err as { observed: unknown }).observed;
        throw err;
      });

    const rows = observed as { status: string; windowStart: Date; windowEnd: Date; decidedAt: Date | null }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('PENDING');
    expect(rows[0]!.decidedAt).toBeNull();
    // Forward-dated: a leave window already in the past is not something a manager can act on, and
    // the recommender would never consult it.
    expect(rows[0]!.windowStart.getTime()).toBeGreaterThan(Date.now());
    expect(rows[0]!.windowEnd.getTime()).toBeGreaterThan(rows[0]!.windowStart.getTime());
  });

  it('raises a Platinum case through a scoped, expiring tier override — never by re-tiering the company', async () => {
    const ROLLBACK = new Error('rollback');

    const observed = await prisma
      .$transaction(async (tx) => {
        const se = await tx.user.findUniqueOrThrow({
          where: { userId: SHARED_AUTH_SE_ID },
          select: { zoneId: true },
        });
        // Plants carry no company in this schema — the association is made on the ticket itself.
        const plantRow = await tx.plant.findFirstOrThrow({
          where: { zoneId: se.zoneId! },
          orderBy: { plantId: 'asc' },
          select: { plantId: true },
        });
        const companyRow = await tx.company.findFirstOrThrow({ select: { companyId: true } });
        const plant = { plantId: plantRow.plantId, companyId: companyRow.companyId };

        // A ticket old enough for the Platinum sweep's 4-hour floor, in the SE's zone, GOLD to start
        // with — so the seeder has to be the thing that makes it Platinum.
        const raisedAt = new Date(Date.now() - 5 * 60 * 60 * 1000);
        const deviceId = `dev-fixture-${Date.now()}`;
        await tx.device.create({ data: { deviceId } });
        const cycle = await tx.failureCycle.create({
          data: { deviceId, state: 'OPEN', openedAt: raisedAt },
        });
        const ticket = await tx.ticket.create({
          data: {
            workType: 'TROUBLESHOOT',
            status: 'OPEN',
            failureCycleId: cycle.cycleId,
            deviceId,
            plantId: plant.plantId,
            companyId: plant.companyId,
            companyTier: 'GOLD',
            assignmentState: 'UNASSIGNED',
            lastStateChangedAt: raisedAt,
            createdAt: raisedAt,
          },
        });

        const companyBefore = await tx.company.findUniqueOrThrow({
          where: { companyId: plant.companyId },
          select: { companyTier: true },
        });

        await seedDevWalkFixtures(tx as unknown as PrismaService, ALLOWED_ENV);

        const override = await tx.companyTierOverride.findFirst({
          where: { companyId: plant.companyId, zoneId: se.zoneId!, status: 'ACTIVE' },
        });
        const companyAfter = await tx.company.findUniqueOrThrow({
          where: { companyId: plant.companyId },
          select: { companyTier: true },
        });
        const ticketAfter = await tx.ticket.findUniqueOrThrow({
          where: { ticketId: ticket.ticketId },
          select: { companyTier: true, status: true, assignmentState: true },
        });

        throw Object.assign(ROLLBACK, {
          observed: { override, companyBefore, companyAfter, ticketAfter },
        });
      })
      .catch((err: unknown) => {
        if (err === ROLLBACK) return (err as { observed: Record<string, unknown> }).observed;
        throw err;
      });

    const { override, companyBefore, companyAfter, ticketAfter } = observed as {
      override: { tier: string; reason: string; expiresAt: Date } | null;
      companyBefore: { companyTier: string };
      companyAfter: { companyTier: string };
      ticketAfter: { companyTier: string; status: string; assignmentState: string };
    };

    expect(override).not.toBeNull();
    expect(override!.tier).toBe('PLATINUM');
    // Expiring, and within #157's two-month ceiling — a fixture that never lapses is a permanent
    // change wearing a temporary name.
    expect(override!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(override!.expiresAt.getTime()).toBeLessThan(Date.now() + 62 * 24 * 60 * 60 * 1000);
    expect(override!.reason).toMatch(/336/);

    // The whole point of choosing an override: the company's own tier is untouched, so no other zone
    // and no other report sees this company differently.
    expect(companyAfter.companyTier).toBe(companyBefore.companyTier);

    // …and the ticket's snapshot agrees with the override, because `sweepAutoEscalations` filters on
    // `tickets.company_tier` (`cross-zone-escalation.service.ts:77`), not on the effective tier. An
    // override without the snapshot would be a Platinum case the Platinum sweep cannot see.
    expect(ticketAfter.companyTier).toBe('PLATINUM');
    expect(ticketAfter.status).toBe('OPEN');
    expect(ticketAfter.assignmentState).toBe('UNASSIGNED');
  });

  it('seeds the three verification shapes the verification module has never had a row for', async () => {
    const ROLLBACK = new Error('rollback');

    const observed = await prisma
      .$transaction(async (tx) => {
        // `fsm_test` is truncated and org-seeded; it holds no tickets, so the runs have nothing to
        // hang off unless this spec supplies them. Three, spread over two zones where the seeded
        // reference data offers a second one, which is what lets the fraud row land out of zone.
        const company = await tx.company.findFirstOrThrow({ select: { companyId: true } });
        const plants = await tx.plant.findMany({
          orderBy: { plantId: 'asc' },
          select: { plantId: true, zoneId: true },
          take: 50,
        });
        const seUser = await tx.user.findUniqueOrThrow({
          where: { userId: SHARED_AUTH_SE_ID },
          select: { zoneId: true },
        });
        const homePlant = plants.find((p) => p.zoneId === seUser.zoneId) ?? plants[0]!;
        const foreignPlant = plants.find((p) => p.zoneId !== seUser.zoneId) ?? homePlant;

        let seq = 0;
        const makeTicket = async (plantId: bigint): Promise<void> => {
          seq += 1;
          const deviceId = `dev-fixture-vr-${Date.now()}-${seq}`;
          await tx.device.create({ data: { deviceId } });
          const cycle = await tx.failureCycle.create({
            data: { deviceId, state: 'OPEN', openedAt: new Date() },
          });
          await tx.ticket.create({
            data: {
              workType: 'TROUBLESHOOT',
              status: 'OPEN',
              failureCycleId: cycle.cycleId,
              deviceId,
              plantId,
              companyId: company.companyId,
              companyTier: 'GOLD',
              assignmentState: 'UNASSIGNED',
              lastStateChangedAt: new Date(),
            },
          });
        };

        await makeTicket(homePlant.plantId);
        await makeTicket(homePlant.plantId);
        await makeTicket(foreignPlant.plantId);

        const before = new Set(
          (await tx.verificationRun.findMany({ select: { runId: true } })).map((r) => r.runId),
        );

        const summary = await seedDevWalkFixtures(tx as unknown as PrismaService, ALLOWED_ENV);

        const all = await tx.verificationRun.findMany({
          select: {
            runId: true,
            outcome: true,
            fraudFlag: true,
            pingsReceivedCount: true,
            ticket: { select: { plant: { select: { zoneId: true } } } },
          },
        });
        const created = all.filter((r) => !before.has(r.runId));
        const se = await tx.user.findUniqueOrThrow({
          where: { userId: SHARED_AUTH_SE_ID },
          select: { zoneId: true },
        });

        throw Object.assign(ROLLBACK, { observed: { summary, created, seZoneId: se.zoneId } });
      })
      .catch((err: unknown) => {
        if (err === ROLLBACK) return (err as { observed: Record<string, unknown> }).observed;
        throw err;
      });

    const { summary, created } = observed as {
      summary: { verificationRuns: number };
      created: {
        outcome: string | null;
        fraudFlag: boolean;
        pingsReceivedCount: number;
        ticket: { plant: { zoneId: bigint } };
      }[];
    };

    expect(summary.verificationRuns).toBe(3);
    expect(created).toHaveLength(3);

    // The three shapes, each of which a different blocked finding needs. There is no FAILED_NO_PINGS
    // outcome in this schema — "failed for want of pings" is FAILED_VERIFICATION with a zero ping
    // count, which is exactly the row V-01's stale-verdict bug acts on.
    const noPings = created.filter((r) => r.outcome === 'FAILED_VERIFICATION' && r.pingsReceivedCount === 0);
    const fraud = created.filter((r) => r.fraudFlag);
    const closed = created.filter((r) => r.outcome === 'CLOSED');

    expect(noPings).toHaveLength(1);
    expect(fraud).toHaveLength(1);
    expect(closed).toHaveLength(1);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const ROLLBACK = new Error('rollback');

    const observed = await prisma
      .$transaction(async (tx) => {
        await tx.seCoverage.deleteMany({ where: { seId: SHARED_AUTH_SE_ID } });
        await tx.engineerMaster.deleteMany({ where: { engineerId: SHARED_AUTH_SE_ID } });
        // Enough tickets that every ticket-derived block has something to do on the FIRST pass —
        // otherwise "created nothing twice" is true for the wrong reason.
        await makeTickets(tx, 4);

        const first = await seedDevWalkFixtures(tx as unknown as PrismaService, ALLOWED_ENV);
        const afterFirst = await tx.seCoverage.count({ where: { seId: SHARED_AUTH_SE_ID } });

        const second = await seedDevWalkFixtures(tx as unknown as PrismaService, ALLOWED_ENV);
        const afterSecond = await tx.seCoverage.count({ where: { seId: SHARED_AUTH_SE_ID } });

        throw Object.assign(ROLLBACK, { observed: { first, second, afterFirst, afterSecond } });
      })
      .catch((err: unknown) => {
        if (err === ROLLBACK) return (err as { observed: Record<string, unknown> }).observed;
        throw err;
      });

    const { first, second, afterFirst, afterSecond } = observed as {
      first: Record<string, number>;
      second: Record<string, number>;
      afterFirst: number;
      afterSecond: number;
    };

    // The second run must not duplicate the coverage row — `se_coverage` has no natural key a blind
    // create would collide on for MULTI_PLANT, so "ran twice" is how duplicates get in.
    expect(afterSecond).toBe(afterFirst);
    expect(first.engineer).toBe(1);

    // Every counter, not just the two that were easy: each block guards itself, and a guard that is
    // right for one row shape says nothing about the next. The verification block is the one this
    // catches — "a ticket with no run yet" is true of a *different* ticket on every pass.
    for (const [key, value] of Object.entries(second)) {
      expect({ [key]: value }).toEqual({ [key]: 0 });
    }
  });
});
