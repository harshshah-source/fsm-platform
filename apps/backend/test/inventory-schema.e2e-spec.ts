import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 21, slice 1 — inventory schema (LLD D12). component_master, se_van_stock (the Common-Kit
 * source), the common_kit_definition FK to component_master, and component_blocked_queue (tickets
 * dropped from a Day Plan for a missing Common Kit). Asserts the FK chains, the per-SE/component
 * uniques, and the non-negative-stock CHECK.
 */
describe('Issue 21 slice 1 — inventory schema', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  const indexDefs = async (table: string): Promise<string[]> => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${table}`;
    return rows.map((r) => r.indexdef);
  };
  const checkDefs = async (table: string): Promise<string> => {
    const rows = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = ${table} AND c.contype = 'c'`;
    return rows.map((r) => r.def).join(' | ');
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

  it('creates se_van_stock with the FK chain, the (se, component) unique, and qty >= 0', async () => {
    expect(await fkExists('se_van_stock', 'se_id', 'engineer_master')).toBe(true);
    expect(await fkExists('se_van_stock', 'component_id', 'component_master')).toBe(true);
    const defs = await indexDefs('se_van_stock');
    expect(defs.some((d) => /UNIQUE/.test(d) && /se_id/.test(d) && /component_id/.test(d))).toBe(true);
    expect(/qty/.test(await checkDefs('se_van_stock'))).toBe(true);
  });

  it('adds the common_kit_definition FK to component_master', async () => {
    expect(await fkExists('common_kit_definition', 'component_id', 'component_master')).toBe(true);
  });

  it('creates component_blocked_queue with one active row per ticket', async () => {
    expect(await fkExists('component_blocked_queue', 'ticket_id', 'tickets')).toBe(true);
    const defs = await indexDefs('component_blocked_queue');
    expect(defs.some((d) => /UNIQUE/.test(d) && /ticket_id/.test(d) && /resolved_at IS NULL/.test(d))).toBe(true);
  });
});
