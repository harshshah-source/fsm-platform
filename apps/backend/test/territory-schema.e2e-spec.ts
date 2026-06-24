import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 09, slice 1 — geography + PostGIS foundation for Floating-SE territory (ADR-0006).
 *
 * Asserts, through a real connection + catalogue queries:
 *  - the PostGIS extension is installed (the hard dependency `ST_Contains` rests on).
 *  - the admin-geography tables exist: `regions`, `districts` (district → region rollup).
 *  - `plants` carries a `location geometry(Point,4326)` for territory membership, GIST-indexed,
 *    and its `district_id` is FK-bound to `districts`.
 */
describe('Issue 09 slice 1 — geography / PostGIS foundation schema', () => {
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

  const fkExists = async (table: string, column: string, refTable: string): Promise<boolean> => {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = ${table} AND kcu.column_name = ${column}
        AND ccu.table_name = ${refTable}`;
    return Number(rows[0].n) >= 1;
  };

  it('has the PostGIS extension installed', async () => {
    const rows = await prisma.$queryRaw<{ extname: string }[]>`SELECT extname FROM pg_extension WHERE extname = 'postgis'`;
    expect(rows).toHaveLength(1);
  });

  it('creates regions and districts geography tables', async () => {
    expect(await tableExists('regions')).toBe(true);
    expect(await tableExists('districts')).toBe(true);
  });

  it('binds districts.region_id → regions and keys district uniquely per state', async () => {
    expect(await fkExists('districts', 'region_id', 'regions')).toBe(true);
    const defs = await indexDefs('districts');
    expect(defs.some((d) => /unique/i.test(d) && /name/i.test(d) && /state/i.test(d))).toBe(true);
  });

  it('gives plants a geometry(Point,4326) location, GIST-indexed', async () => {
    const geo = await prisma.$queryRaw<{ type: string; srid: number }[]>`
      SELECT type, srid FROM geometry_columns
      WHERE f_table_name = 'plants' AND f_geometry_column = 'location'`;
    expect(geo).toHaveLength(1);
    expect(geo[0].type).toBe('POINT');
    expect(geo[0].srid).toBe(4326);

    const defs = await indexDefs('plants');
    expect(defs.some((d) => /gist/i.test(d) && /location/i.test(d))).toBe(true);
  });

  it('binds plants.district_id → districts', async () => {
    expect(await fkExists('plants', 'district_id', 'districts')).toBe(true);
  });
});
