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

/** The narrow slice of the client this fixture touches — a transaction client satisfies it too. */
export type SharedAuthSeClient = Pick<PrismaClient, 'user' | 'engineerMaster' | 'seCoverage'>;

interface CoverPlantOptions {
  /** Zone the spec's fixtures hang off. Only used when this spec is the first to mint the SE's
   *  `engineer_master` row; a later spec's value is ignored, exactly as before. */
  zoneId: bigint;
  /** The spec's own plant, which the shared SE must be able to touch. */
  plantId: bigint;
  /** Per-spec uniqueness tag (typically `` `sc-${NS}` ``) for the contact columns. Only applied on
   *  the fresh-database path where `users` has not already been seeded. */
  tag: string;
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
 * The `engineer_master.coverage_type` classification is deliberately left `DEDICATED`, unchanged:
 * it carries no partial unique, it is what eleven other specs already upsert, and
 * `component-request-controller` exercises `computeResubmitOwnership()`, which reads it. The two
 * columns answer different questions — establishment-level classification vs. this-plant coverage.
 */
export async function ensureSharedSeCoversPlant(
  prisma: SharedAuthSeClient,
  { zoneId, plantId, tag }: CoverPlantOptions,
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
  await prisma.engineerMaster.upsert({
    where: { engineerId: SHARED_AUTH_SE_ID },
    create: { engineerId: SHARED_AUTH_SE_ID, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    update: {},
  });
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
