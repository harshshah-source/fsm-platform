import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 18, slice 1 — the verification_runs schema (LLD D14). Three-phase auto-GPS verification of
 * recovery pings; fraud flag; the source of the PARTIAL_RECOVERY badge. Asserts the enum columns, the
 * FK chain (ticket + Phase-1 submission anchor), and the one-in-flight-run-per-ticket partial unique.
 */
describe('Issue 18 slice 1 — verification_runs schema', () => {
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

  it('creates verification_runs with enum phase/outcome columns and the FK chain', async () => {
    expect(await columnType('verification_runs', 'phase')).toBe('verify_phase');
    expect(await columnType('verification_runs', 'outcome')).toBe('verify_outcome');
    expect(await fkExists('verification_runs', 'ticket_id', 'tickets')).toBe(true);
    expect(await fkExists('verification_runs', 'submission_id', 'troubleshooting_submissions')).toBe(true);
  });

  it('enforces one in-flight run per ticket via a partial unique on outcome IS NULL', async () => {
    const defs = await indexDefs('verification_runs');
    expect(defs.some((d) => /UNIQUE/.test(d) && /ticket_id/.test(d) && /outcome IS NULL/.test(d))).toBe(true);
  });
});
