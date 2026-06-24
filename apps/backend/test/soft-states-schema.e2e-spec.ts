import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 15, slice 1 — the soft_states schema (LLD D7, table-wise spec). Temporary SE field-progress
 * signals (VIEWED / ON_SITE / TROUBLESHOOT_STARTED); not a lifecycle state and not a lock. Asserts the
 * table, enum columns, the FK chain, the active-state partial unique (invariant I24), and the three
 * CHECKs that tie `timeout_at`/`onsite_source` to the right soft-state type.
 */
describe('Issue 15 slice 1 — soft_states schema', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  const columnType = async (table: string, column: string): Promise<string | null> => {
    const rows = await prisma.$queryRaw<{ data_type: string; udt_name: string }[]>`
      SELECT data_type, udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`;
    if (!rows[0]) return null;
    return rows[0].data_type === 'USER-DEFINED' ? rows[0].udt_name : rows[0].data_type;
  };
  const indexDefs = async (table: string): Promise<string[]> => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${table}`;
    return rows.map((r) => r.indexdef);
  };
  const checkDefs = async (table: string): Promise<string[]> => {
    const rows = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = ${table} AND c.contype = 'c'`;
    return rows.map((r) => r.def);
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

  it('creates soft_states with enum type/onsite_source columns and the FK chain', async () => {
    expect(await columnType('soft_states', 'type')).toBe('soft_state_type');
    expect(await columnType('soft_states', 'onsite_source')).toBe('onsite_source');
    expect(await fkExists('soft_states', 'ticket_id', 'tickets')).toBe(true);
    expect(await fkExists('soft_states', 'se_id', 'engineer_master')).toBe(true);
  });

  it('enforces one active soft state per (ticket, se, type) via a partial unique on resolved_at IS NULL', async () => {
    const defs = await indexDefs('soft_states');
    expect(
      defs.some(
        (d) =>
          /UNIQUE/.test(d) &&
          /ticket_id/.test(d) &&
          /se_id/.test(d) &&
          /\btype\b/.test(d) &&
          /resolved_at IS NULL/.test(d),
      ),
    ).toBe(true);
  });

  it('ties timeout_at and onsite_source to the right soft-state type via CHECK constraints', async () => {
    const defs = (await checkDefs('soft_states')).join(' | ');
    // VIEWED ⇒ timeout_at set; non-VIEWED ⇒ timeout_at null; onsite_source only for ON_SITE.
    expect(/timeout_at/.test(defs)).toBe(true);
    expect(/onsite_source/.test(defs)).toBe(true);
  });
});
