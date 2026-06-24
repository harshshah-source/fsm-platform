import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 12, slice 2 — the Shared Pool query index (LLD §3 tickets: partial
 * `(plant_id) WHERE status='OPEN' AND assignment_state='UNASSIGNED'`). Makes the per-plant
 * "secondary open work" lookup an index scan; asserts the partial index exists with the right
 * predicate.
 */
describe('Issue 12 slice 2 — shared-pool tickets partial index', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('has a partial (plant_id) index scoped to OPEN + UNASSIGNED tickets', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'tickets'`;
    const defs = rows.map((r) => r.indexdef);
    expect(
      defs.some(
        (d) =>
          /\(plant_id\)/.test(d) &&
          /status = 'OPEN'/.test(d) &&
          /assignment_state = 'UNASSIGNED'/.test(d),
      ),
    ).toBe(true);
  });
});
