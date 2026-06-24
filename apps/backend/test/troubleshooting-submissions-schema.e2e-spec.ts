import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 16, slice 1 — the troubleshooting_submissions schema (LLD D11). The SE form submission, a
 * 1-to-many child of a Ticket; carries the structured root cause (the analytics source), the silent
 * SE GPS anchor, and storage-level idempotency. Asserts the enum columns, the FK chain, the
 * (se_id, client_submission_id) unique, and the component-unavailable CHECK.
 */
describe('Issue 16 slice 1 — troubleshooting_submissions schema', () => {
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

  it('creates troubleshooting_submissions with enum + array columns and the FK chain', async () => {
    expect(await columnType('troubleshooting_submissions', 'submission_type')).toBe('submission_type');
    expect(await columnType('troubleshooting_submissions', 'presence_source')).toBe('presence_source');
    expect(await columnType('troubleshooting_submissions', 'root_cause_category')).toBe('root_cause_category');
    expect(await columnType('troubleshooting_submissions', 'photo_refs')).toBe('ARRAY');
    expect(await fkExists('troubleshooting_submissions', 'ticket_id', 'tickets')).toBe(true);
    expect(await fkExists('troubleshooting_submissions', 'failure_cycle_id', 'failure_cycles')).toBe(true);
    expect(await fkExists('troubleshooting_submissions', 'se_id', 'engineer_master')).toBe(true);
  });

  it('enforces storage-level idempotency via a unique on (se_id, client_submission_id)', async () => {
    const defs = await indexDefs('troubleshooting_submissions');
    expect(defs.some((d) => /UNIQUE/.test(d) && /se_id/.test(d) && /client_submission_id/.test(d))).toBe(true);
  });

  it('requires a named part when component_unavailable is set (CHECK)', async () => {
    const defs = await checkDefs('troubleshooting_submissions');
    expect(/component_unavailable/.test(defs)).toBe(true);
  });
});
