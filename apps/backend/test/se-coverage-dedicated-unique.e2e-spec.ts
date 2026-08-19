import { PrismaService } from '../src/prisma/prisma.service';

/** The violated constraint's own column list, as the driver reports it. `['se_id']` is the partial
 *  index `se_coverage_dedicated_se_key`; the declared `@@unique([seId, plantId])` would report
 *  `['se_id', 'plant_id']`. Asserting on it is what stops these tests passing for the wrong reason. */
const DEDICATED_INDEX_VIOLATION = {
  code: 'P2002',
  meta: { driverAdapterError: { cause: { constraint: { fields: ['se_id'] } } } },
};

/**
 * #255 AC-4 — the behavioural pin for `se_coverage_dedicated_se_key`, the partial unique declared in
 * raw SQL at `prisma/migrations/20260618121101_add_engineer_se_coverage/migration.sql:60`:
 *
 *     CREATE UNIQUE INDEX "se_coverage_dedicated_se_key"
 *       ON "se_coverage"("se_id") WHERE "coverage_type" = 'DEDICATED';
 *
 * It encodes a real business rule (CONTEXT.md — a DEDICATED SE holds exactly one coverage row), but a
 * partial predicate is not expressible in the Prisma schema, so the generated client cannot see it.
 * That gap is what made #255: `seCoverage.upsert({ where: { seId_plantId } })` resolves its conflict
 * against the *declared* `@@unique([seId, plantId])` only, so two callers at two different plants both
 * decide there is no conflict, both INSERT, and Postgres rejects the loser at the index.
 *
 * These three tests pin the exact asymmetry the fixture helper relies on, so that if the index is ever
 * dropped or widened, the reason `ensureSharedSeCoversPlant()` writes MULTI_PLANT stops being folklore
 * and fails out loud instead.
 */
describe('se_coverage_dedicated_se_key — the partial unique Prisma cannot see (#255)', () => {
  let prisma: PrismaService;
  const NS = Date.now();
  let zoneId: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let seId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    zoneId = (await prisma.zone.create({ data: { name: `Z-dedchk-${NS}` } })).zoneId;
    plantA = (await prisma.plant.create({ data: { name: `P-dedchk-a-${NS}`, zoneId } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: `P-dedchk-b-${NS}`, zoneId } })).plantId;
    const user = await prisma.user.create({
      data: {
        name: 'SE DedChk',
        role: 'SERVICE_ENGINEER',
        phone: `ph-dedchk-${NS}`,
        email: `se-dedchk-${NS}@x.test`,
        zoneId,
      },
    });
    seId = user.userId;
    await prisma.engineerMaster.create({ data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    // se_coverage before engineer_master — se_coverage_se_id_fkey is ON DELETE RESTRICT.
    await prisma.seCoverage.deleteMany({ where: { seId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: seId } });
    await prisma.user.deleteMany({ where: { userId: seId } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('rejects a second DEDICATED coverage row for the same SE, even at a different plant', async () => {
    // shared-auth-se-guard-ok: this spec owns a private SE created in its own beforeAll and is the
    // one place that must actually provoke the constraint.
    await prisma.seCoverage.create({ data: { seId, plantId: plantA, coverageType: 'DEDICATED' } });

    await expect(
      prisma.seCoverage.create({ data: { seId, plantId: plantB, coverageType: 'DEDICATED' } }),
    ).rejects.toMatchObject(DEDICATED_INDEX_VIOLATION);

    await prisma.seCoverage.deleteMany({ where: { seId } });
  });

  it('an upsert keyed on (se_id, plant_id) does NOT protect against it — the #255 mechanism exactly', async () => {
    // shared-auth-se-guard-ok: reproducing the raced upsert is the point of this test.
    await prisma.seCoverage.upsert({
      where: { seId_plantId: { seId, plantId: plantA } },
      create: { seId, plantId: plantA, coverageType: 'DEDICATED' },
      update: {},
    });

    // Different plant → Prisma sees no conflict on its declared unique and issues an INSERT, which
    // the invisible partial index then rejects. This is what fired in `beforeAll` across five specs.
    await expect(
      prisma.seCoverage.upsert({
        where: { seId_plantId: { seId, plantId: plantB } },
        create: { seId, plantId: plantB, coverageType: 'DEDICATED' },
        update: {},
      }),
    ).rejects.toMatchObject(DEDICATED_INDEX_VIOLATION);

    await prisma.seCoverage.deleteMany({ where: { seId } });
  });

  it('accepts MULTI_PLANT coverage for the same SE at several plants — why the fixture helper uses it', async () => {
    await prisma.seCoverage.create({ data: { seId, plantId: plantA, coverageType: 'MULTI_PLANT' } });
    await prisma.seCoverage.create({ data: { seId, plantId: plantB, coverageType: 'MULTI_PLANT' } });

    const rows = await prisma.seCoverage.findMany({ where: { seId } });
    expect(rows).toHaveLength(2);

    await prisma.seCoverage.deleteMany({ where: { seId } });
  });
});
