import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 05, slice 2 — the device-state → ticket spine schema lands clean against local Postgres.
 *
 * Asserts the structural guarantees TicketCreation/DeviceState rest on, through a real connection
 * + catalogue queries (not psql):
 *  - the spine tables exist: `devices`, `vehicles`, `device_states`, `failure_cycles`, `tickets`,
 *    plus the minimal eligibility-input tables `pgi_history`, `non_operational_markings` (Option 1).
 *  - `device_states` is keyed one-row-per-device (PK `device_id`).
 *  - invariant I1 — one active Failure Cycle per device: a *partial* UNIQUE index on
 *    `failure_cycles (device_id) WHERE state IN ('OPEN','WAITING_COMPONENT','SUBMITTED')`.
 *  - invariant I2 — one Ticket per Failure Cycle: a UNIQUE on `tickets (failure_cycle_id)`.
 *  - invariant I13 — one active Non-Op marking per device: a *partial* UNIQUE on
 *    `non_operational_markings (device_id) WHERE state IN ('CONFIRMED','ACTIVE')`.
 */
describe('Issue 05 slice 2 — device-state / ticket spine schema', () => {
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

  const pkColumns = async (table: string): Promise<string[]> => {
    const rows = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = ${table}::regclass AND i.indisprimary`;
    return rows.map((r) => r.column_name);
  };

  it('creates the device-state / ticket spine + eligibility-input tables', async () => {
    expect(await tableExists('devices')).toBe(true);
    expect(await tableExists('vehicles')).toBe(true);
    expect(await tableExists('device_states')).toBe(true);
    expect(await tableExists('failure_cycles')).toBe(true);
    expect(await tableExists('tickets')).toBe(true);
    expect(await tableExists('pgi_history')).toBe(true);
    expect(await tableExists('non_operational_markings')).toBe(true);
  });

  it('keys device_states one row per device (PK device_id)', async () => {
    expect(await pkColumns('device_states')).toEqual(['device_id']);
  });

  it('enforces I1 — one active Failure Cycle per device (partial unique on active states)', async () => {
    const defs = await indexDefs('failure_cycles');
    const guard = defs.find(
      (d) =>
        /unique/i.test(d) &&
        /device_id/i.test(d) &&
        /where\b/i.test(d) &&
        /\bOPEN\b/.test(d),
    );
    expect(guard).toBeDefined();
  });

  it('enforces I2 — one Ticket per Failure Cycle (unique on failure_cycle_id)', async () => {
    const defs = await indexDefs('tickets');
    const uq = defs.find((d) => /unique/i.test(d) && /failure_cycle_id/i.test(d));
    expect(uq).toBeDefined();
  });

  it('enforces I13 — one active Non-Op marking per device (partial unique on CONFIRMED/ACTIVE)', async () => {
    const defs = await indexDefs('non_operational_markings');
    const guard = defs.find(
      (d) =>
        /unique/i.test(d) &&
        /device_id/i.test(d) &&
        /where\b/i.test(d) &&
        /CONFIRMED/.test(d),
    );
    expect(guard).toBeDefined();
  });
});
