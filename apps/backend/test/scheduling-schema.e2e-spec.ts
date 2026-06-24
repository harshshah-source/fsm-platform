import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 11, slice 1 — the dispatch/Day-Plan schema (LLD §3.6, schema D-sched).
 * Three coupled tables that turn Recommender output into a dispatched, plant-clustered Day Plan:
 *   work_schedules ← plant_batch_assignments ← batch_assignment_tickets.
 * No approval gate (ADR-0007/0019 superseded): work_schedules has no DRAFT/PENDING_REVIEW/APPROVED;
 * batches dispatch as AUTO_ASSIGNED. Asserts tables, enum columns, the FK chain, the read indexes,
 * and the partial-unique "one active batch per ticket" guard.
 */
describe('Issue 11 slice 1 — scheduling schema', () => {
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
  const enumLabels = async (enumName: string): Promise<string[]> => {
    const rows = await prisma.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = ${enumName}
      ORDER BY e.enumsortorder`;
    return rows.map((r) => r.label);
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

  it('creates work_schedules with status/source enums and no approval-gate states', async () => {
    expect(await tableExists('work_schedules')).toBe(true);
    expect(await columnType('work_schedules', 'status')).toBe('USER-DEFINED');
    expect(await columnType('work_schedules', 'source')).toBe('USER-DEFINED');
    expect(await enumLabels('work_schedule_status')).toEqual([
      'ACTIVE',
      'OVERRIDDEN',
      'COMPLETED',
      'PARTIAL',
    ]);
    expect(await enumLabels('schedule_source')).toEqual(['SYSTEM_GENERATED', 'ZM_MANUAL']);
  });

  it('binds work_schedules se_id → engineer_master and zone_id → zones, with read indexes', async () => {
    expect(await fkExists('work_schedules', 'se_id', 'engineer_master')).toBe(true);
    expect(await fkExists('work_schedules', 'zone_id', 'zones')).toBe(true);
    const defs = await indexDefs('work_schedules');
    expect(defs.some((d) => /\(se_id, date_from\)/.test(d))).toBe(true);
    expect(defs.some((d) => /\(zone_id, status\)/.test(d))).toBe(true);
  });

  it('creates plant_batch_assignments with batch_status enum starting AUTO_ASSIGNED and its FK chain', async () => {
    expect(await tableExists('plant_batch_assignments')).toBe(true);
    expect(await columnType('plant_batch_assignments', 'status')).toBe('USER-DEFINED');
    expect(await enumLabels('batch_status')).toEqual([
      'AUTO_ASSIGNED',
      'OVERRIDDEN',
      'COMPLETED',
      'PARTIAL',
    ]);
    expect(await columnType('plant_batch_assignments', 'stop_sequence')).toBe('integer');
    expect(await fkExists('plant_batch_assignments', 'schedule_id', 'work_schedules')).toBe(true);
    expect(await fkExists('plant_batch_assignments', 'plant_id', 'plants')).toBe(true);
    expect(await fkExists('plant_batch_assignments', 'se_id', 'engineer_master')).toBe(true);
  });

  it('creates batch_assignment_tickets with FKs and a one-active-batch-per-ticket partial unique', async () => {
    expect(await tableExists('batch_assignment_tickets')).toBe(true);
    expect(await fkExists('batch_assignment_tickets', 'batch_id', 'plant_batch_assignments')).toBe(true);
    expect(await fkExists('batch_assignment_tickets', 'ticket_id', 'tickets')).toBe(true);
    const defs = await indexDefs('batch_assignment_tickets');
    expect(
      defs.some((d) => /UNIQUE/.test(d) && /\(ticket_id\)/.test(d) && /removed_at IS NULL/.test(d)),
    ).toBe(true);
  });
});
