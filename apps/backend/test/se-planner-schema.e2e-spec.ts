import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 14a, slice 1 — the se_planner schema (LLD §3.6). ZM-authored plant-visit intents
 * (SE × plant × date); the Morning Batch reads them as a soft bias. Asserts the table, the date
 * column, the FK chain, and the one-intent-per (se, plant, date) unique.
 */
describe('Issue 14a slice 1 — se_planner schema', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  const columnType = async (table: string, column: string): Promise<string | null> => {
    const rows = await prisma.$queryRaw<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`;
    return rows[0]?.data_type ?? null;
  };
  const indexDefs = async (table: string): Promise<string[]> => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${table}`;
    return rows.map((r) => r.indexdef);
  };
  const fkExists = async (table: string, column: string, refTable: string): Promise<boolean> => {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = ${table} AND kcu.column_name = ${column} AND ccu.table_name = ${refTable}`;
    return Number(rows[0].n) >= 1;
  };

  it('creates se_planner with a date column and the FK chain', async () => {
    expect(await columnType('se_planner', 'planned_date')).toBe('date');
    expect(await fkExists('se_planner', 'se_id', 'engineer_master')).toBe(true);
    expect(await fkExists('se_planner', 'plant_id', 'plants')).toBe(true);
  });

  it('enforces one intent per (se, plant, planned_date)', async () => {
    const defs = await indexDefs('se_planner');
    expect(
      defs.some(
        (d) => /UNIQUE/.test(d) && /se_id/.test(d) && /plant_id/.test(d) && /planned_date/.test(d),
      ),
    ).toBe(true);
  });
});
