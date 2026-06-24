import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 09, slice 2 — `engineer_territory_coverage` (Floating-SE Territory, ADR-0006, schema D3).
 *
 * Hierarchical (state/region/district) AND/OR polygon; membership is the union. Asserts the table,
 * its FKs (se→engineer_master, district→districts, region→regions), the `(se_id)` index and the
 * GIST `(polygon)` index, plus the raw-SQL CHECK that at least one territory dimension is set
 * (a row defining no territory is meaningless and must be rejected). `polygon` is reserved here;
 * the map-drawing editor is deferred (v1 uses hierarchical selectors only).
 */
const TBL = 'engineer_territory_coverage';

describe('Issue 09 slice 2 — engineer_territory_coverage schema', () => {
  let prisma: PrismaService;
  let seId: string;
  let zoneId: bigint;
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    zoneId = (await prisma.zone.create({ data: { name: 'Z-tc-' + Date.now() } })).zoneId;
    const stamp = Date.now();
    userId = (
      await prisma.user.create({
        data: { name: 'Float SE', role: 'SERVICE_ENGINEER', phone: 'p-tc-' + stamp, email: `tc-${stamp}@x.io`, zoneId },
      })
    ).userId;
    seId = (
      await prisma.engineerMaster.create({
        data: { engineerId: userId, coverageType: 'FLOATING', zoneId, dailyCapacity: 6 },
      })
    ).engineerId;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "${TBL}" WHERE se_id = '${seId}'`);
    await prisma.engineerMaster.deleteMany({ where: { engineerId: seId } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  const tableExists = async (name: string): Promise<boolean> => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${name}`;
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
        AND tc.table_name = ${table} AND kcu.column_name = ${column} AND ccu.table_name = ${refTable}`;
    return Number(rows[0].n) >= 1;
  };

  it('creates the table with se/district/region FKs and se + polygon(GIST) indexes', async () => {
    expect(await tableExists(TBL)).toBe(true);
    expect(await fkExists(TBL, 'se_id', 'engineer_master')).toBe(true);
    expect(await fkExists(TBL, 'district_id', 'districts')).toBe(true);
    expect(await fkExists(TBL, 'region_id', 'regions')).toBe(true);
    const defs = await indexDefs(TBL);
    expect(defs.some((d) => /\(se_id\)/.test(d))).toBe(true);
    expect(defs.some((d) => /gist/i.test(d) && /polygon/i.test(d))).toBe(true);
  });

  it('rejects a row defining no territory dimension (CHECK), accepts one that does', async () => {
    let threw = false;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${TBL}" (se_id, district_id, region_id, state, polygon) VALUES ('${seId}', NULL, NULL, NULL, NULL)`,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // A hierarchical (state) dimension is enough to be valid.
    const id = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${TBL}" (se_id, district_id, region_id, state, polygon) VALUES ('${seId}', NULL, NULL, 'Maharashtra', NULL)`,
    );
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "${TBL}" WHERE se_id = '${seId}' AND state = 'Maharashtra'`,
    );
    expect(Number(rows[0].n)).toBe(1);
    void id;
  });
});
