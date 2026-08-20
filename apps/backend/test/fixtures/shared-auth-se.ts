import type { PrismaClient } from '../../src/generated/prisma/client';

/**
 * The auth-fixture Service Engineer that sixteen e2e specs log in as (#255).
 *
 * `se.north@fsm.test` is seeded once, into `users`, by `test/global-setup.ts` →
 * `seedAuthFixtureUsers`. Specs that exercise an SE-facing surface reuse that identity because token
 * minting and the `login()` helpers are keyed to it; they do **not** mint their own SE.
 *
 * Sharing is safe for `users` and `engineer_master` — both are keyed on the id itself, so a
 * per-file upsert is genuinely idempotent — and **unsafe for `se_coverage`**, which is why the
 * coverage write lives here instead of being copy-pasted per file. See `ensureSharedSeCoversPlant`.
 */
export const SHARED_AUTH_SE_ID = '22222222-2222-2222-2222-222222222222';

/**
 * The canonical zone for the shared SE's `engineer_master` row — the zone its seeded `users` row
 * already names, and `zm.north`'s (#215). One value, seeded once; no spec chooses it.
 */
export const SHARED_AUTH_SE_ZONE_NAME = 'North';

/** The narrow slice of the client this fixture touches — a transaction client satisfies it too. */
export type SharedAuthSeClient = Pick<PrismaClient, 'user' | 'engineerMaster' | 'seCoverage' | 'zone'>;

/**
 * Seed the shared SE's canonical `engineer_master` row (#215 / #187) — called by `test/global-setup.ts`
 * right after `seedAuthFixtureUsers`, so the row exists **before any spec runs**, in the North zone.
 *
 * Why this exists: `seedAuthFixtureUsers` seeds the `users` row and never an `engineer_master` row, so
 * for a long time that row was minted by whichever of nine specs happened to run first — each into a
 * throwaway zone of its own, via a create-only upsert where the first writer wins. The SE's zone for
 * the rest of the run was therefore decided by vitest worker scheduling, invisible from any failing
 * test. `voucher-controller` was the victim: its ZM queue scopes on `engineer.zoneId`
 * (`vouchers.service.ts:217`), so it failed 3/5 alone (no row → 400 `SE_NOT_FOUND`) and 2/5 in a full
 * sweep (row in a foreign zone → queue miss + approve 403).
 *
 * Seeding here makes every later create-only upsert for this id structurally unable to win — the #215
 * re-zoning leak is closed by construction, the same shape as #255's MULTI_PLANT coverage fix.
 *
 * Idempotent (create-only upsert), and deliberately NOT part of `seedAuthFixtureUsers` itself: that
 * function is also called by the gated dev-seed runner (`ALLOW_DEV_SEED`), and a fixture engineer row
 * has no business appearing in a development database's engineer directory.
 */
export async function seedSharedAuthSeEngineer(prisma: SharedAuthSeClient): Promise<void> {
  const zone = await prisma.zone.findFirst({ where: { name: SHARED_AUTH_SE_ZONE_NAME } });
  if (!zone) {
    throw new Error(
      `seedSharedAuthSeEngineer: zone '${SHARED_AUTH_SE_ZONE_NAME}' is missing — run seedOrgReferenceData first ` +
        `(global-setup order matters: org seed → auth fixture users → this)`,
    );
  }
  // shared-auth-se-guard-ok: this is the one canonical writer the guard exists to funnel everything into.
  await prisma.engineerMaster.upsert({
    where: { engineerId: SHARED_AUTH_SE_ID },
    create: { engineerId: SHARED_AUTH_SE_ID, coverageType: 'DEDICATED', zoneId: zone.zoneId, dailyCapacity: 10 },
    update: {},
  });
}

interface CoverPlantOptions {
  /** Zone for the users-row create-only backstop. The engineer row's zone is canonical (North) and
   *  never comes from here — see {@link seedSharedAuthSeEngineer}. */
  zoneId: bigint;
  /** The spec's own plant, which the shared SE must be able to touch. */
  plantId: bigint;
  /** Per-spec uniqueness tag (typically `` `sc-${NS}` ``) for the contact columns. Only applied on
   *  the fresh-database path where `users` has not already been seeded. */
  tag: string;
}

/**
 * Make sure the shared SE exists as a `users` + `engineer_master` pair — the identity half, without
 * coverage. This is what the specs that never write `se_coverage` (component-blocked,
 * component-request, media, shadow-use, voucher-controller) need, and what
 * {@link ensureSharedSeCoversPlant} builds on.
 *
 * Both rows normally already exist (users from `seedAuthFixtureUsers`, engineer from
 * `seedSharedAuthSeEngineer`, both in global setup) — the upserts here are create-only backstops so a
 * spec run against a hand-built database still stands up. **Neither takes the caller's zone for the
 * engineer row**: the canonical row lives in North (#215), and a per-spec zone is exactly the leak
 * this module exists to close.
 */
export async function ensureSharedAuthSe(
  prisma: SharedAuthSeClient,
  { zoneId, tag }: { zoneId: bigint; tag: string },
): Promise<void> {
  await prisma.user.upsert({
    where: { userId: SHARED_AUTH_SE_ID },
    create: {
      userId: SHARED_AUTH_SE_ID,
      name: 'SE North',
      role: 'SERVICE_ENGINEER',
      phone: `ph-${tag}`,
      email: `se-${tag}@x.test`,
      zoneId,
    },
    update: {},
  });
  await seedSharedAuthSeEngineer(prisma);
}

/**
 * Makes the shared auth SE cover `plantId`, idempotently and **without claiming exclusivity**.
 *
 * The coverage row is `MULTI_PLANT`, never `DEDICATED`, and that is load-bearing rather than
 * cosmetic. `prisma/migrations/20260618121101_add_engineer_se_coverage/migration.sql:60` declares
 *
 *     CREATE UNIQUE INDEX "se_coverage_dedicated_se_key"
 *       ON "se_coverage"("se_id") WHERE "coverage_type" = 'DEDICATED';
 *
 * — a **partial** unique, so one SE may hold at most one DEDICATED coverage row across the entire
 * table. A partial predicate is not expressible in the Prisma schema, so the client cannot see the
 * index and `upsert` cannot target it: a `where: { seId_plantId }` upsert resolves its conflict
 * against `(se_id, plant_id)` only. Two specs at two different plants therefore both pass the
 * conflict check, both INSERT, and Postgres rejects the loser — inside `beforeAll`, so the losing
 * file reports **zero** tests rather than a failure (#255).
 *
 * `MULTI_PLANT` removes the collision by construction, and is the honest classification: an SE who
 * covers a different plant in each of five specs is not dedicated to any of them. Nothing is lost —
 * the coverage-floor predicate these specs actually exercise, `SeCoverageService.coveredPlantIds`
 * (#162), is a plain "which plants can this SE touch" union and ignores `coverage_type` entirely.
 *
 * The engineer row itself now comes from the canonical North seed (#215) — see
 * {@link seedSharedAuthSeEngineer}. Its `coverage_type` classification stays `DEDICATED`, unchanged:
 * it carries no partial unique, it is what eleven other specs already upsert, and
 * `component-request-controller` exercises `computeResubmitOwnership()`, which reads it. The two
 * columns answer different questions — establishment-level classification vs. this-plant coverage.
 */
export async function ensureSharedSeCoversPlant(
  prisma: SharedAuthSeClient,
  { zoneId, plantId, tag }: CoverPlantOptions,
): Promise<void> {
  await ensureSharedAuthSe(prisma, { zoneId, tag });
  await prisma.seCoverage.upsert({
    where: { seId_plantId: { seId: SHARED_AUTH_SE_ID, plantId } },
    create: { seId: SHARED_AUTH_SE_ID, plantId, coverageType: 'MULTI_PLANT' },
    update: {},
  });
}

/**
 * Teardown counterpart — drops only this spec's own coverage row, leaving the shared `users` and
 * `engineer_master` rows for the specs that follow (deleting them would break every later spec's
 * login, and `se_coverage_se_id_fkey` would reject the delete anyway while any coverage remains).
 */
export async function releaseSharedSePlantCoverage(prisma: SharedAuthSeClient, plantId: bigint): Promise<void> {
  await prisma.seCoverage.deleteMany({ where: { seId: SHARED_AUTH_SE_ID, plantId } });
}
