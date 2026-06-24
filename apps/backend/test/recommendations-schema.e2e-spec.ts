import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 10, slice 1 — the `recommendations` explainability record (LLD §3.6, schema D-sched, AC#6).
 * Append-only per-ticket "why suggested?" row: the recommended SE, the tier/bucket gate context, a
 * `score_breakdown` jsonb (weighted components + multipliers + weight-set ref), processing rank, and
 * the `path` (MORNING_BATCH/INTRADAY). Asserts the table, its FKs (ticket→tickets, se→engineer_master)
 * and the ticket/se read indexes.
 */
describe('Issue 10 slice 1 — recommendations schema', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  const tableExists = async (name: string): Promise<boolean> => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${name}`;
    return rows.length === 1;
  };
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

  it('creates the recommendations table with score_breakdown jsonb and text status', async () => {
    expect(await tableExists('recommendations')).toBe(true);
    expect(await columnType('recommendations', 'score_breakdown')).toBe('jsonb');
    expect(await columnType('recommendations', 'status')).toBe('text');
  });

  it('binds ticket_id → tickets and se_id → engineer_master', async () => {
    expect(await fkExists('recommendations', 'ticket_id', 'tickets')).toBe(true);
    expect(await fkExists('recommendations', 'se_id', 'engineer_master')).toBe(true);
  });

  it('indexes ticket_id and se_id for the read paths', async () => {
    const defs = await indexDefs('recommendations');
    expect(defs.some((d) => /\(ticket_id\)/.test(d))).toBe(true);
    expect(defs.some((d) => /\(se_id\)/.test(d))).toBe(true);
  });
});
