import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 04, slice 1 — the ingestion schema lands clean against local Postgres.
 *
 * Asserts the structural guarantees the SnapshotIngestionWorker rests on, through a real
 * connection + catalogue queries (not psql):
 *  - `snapshot_runs`, `snapshot_run_chunks`, `raw_device_snapshots` exist.
 *  - single in-flight run guard: a *partial* UNIQUE index on `snapshot_runs WHERE status='RUNNING'`.
 *  - chunk retry bookkeeping: UNIQUE `(run_id, chunk_no)` on `snapshot_run_chunks`.
 *  - chunk re-run idempotency: UNIQUE `(device_id, gps_datetime)` on `raw_device_snapshots`.
 *  - telemetry volume: `raw_device_snapshots` is RANGE-partitioned (relkind 'p').
 */
describe('Issue 04 slice 1 — snapshot ingestion schema', () => {
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
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${name}`;
    return rows.length === 1;
  };

  const indexDefs = async (table: string): Promise<string[]> => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${table}`;
    return rows.map((r) => r.indexdef);
  };

  it('creates the three ingestion tables', async () => {
    expect(await tableExists('snapshot_runs')).toBe(true);
    expect(await tableExists('snapshot_run_chunks')).toBe(true);
    expect(await tableExists('raw_device_snapshots')).toBe(true);
  });

  it('guards a single in-flight run with a partial unique index on RUNNING', async () => {
    const defs = await indexDefs('snapshot_runs');
    const guard = defs.find(
      (d) => /unique/i.test(d) && /where\b/i.test(d) && /running/i.test(d),
    );
    expect(guard).toBeDefined();
  });

  it('tracks chunks uniquely per (run_id, chunk_no)', async () => {
    const defs = await indexDefs('snapshot_run_chunks');
    const uq = defs.find(
      (d) => /unique/i.test(d) && /run_id/i.test(d) && /chunk_no/i.test(d),
    );
    expect(uq).toBeDefined();
  });

  it('makes chunk re-runs idempotent via UNIQUE (device_id, gps_datetime)', async () => {
    const defs = await indexDefs('raw_device_snapshots');
    const uq = defs.find(
      (d) => /unique/i.test(d) && /device_id/i.test(d) && /gps_datetime/i.test(d),
    );
    expect(uq).toBeDefined();
  });

  it('range-partitions raw_device_snapshots for telemetry volume', async () => {
    const rows = await prisma.$queryRaw<{ relkind: string }[]>`
      SELECT relkind::text AS relkind FROM pg_class
      WHERE relname = 'raw_device_snapshots' AND relnamespace = 'public'::regnamespace`;
    expect(rows[0]?.relkind).toBe('p'); // 'p' = partitioned table
  });
});
