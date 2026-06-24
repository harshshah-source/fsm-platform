import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 25, slice 1 — the time-windowed SE availability table (ADR-0010, CONTEXT §SE Availability).
 * `se_availability` records a status (AVAILABLE / ON_LEAVE / OFF_SHIFT / WEEKLY_OFF / SOFT_UNAVAILABLE /
 * OFFLINE) over a [window_start, window_end?) window. Asserts the FK to engineer_master and a round-trip.
 */
const NS = Date.now();

describe('Issue 25 slice 1 — se_availability schema', () => {
  let prisma: PrismaService;
  let zoneId: bigint;
  let se: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    zoneId = (await prisma.zone.create({ data: { name: 'Z-sa-' + NS } })).zoneId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'se-' + tag, email: `se-${tag}@sa.test`, zoneId } });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.seAvailability.deleteMany({ where: { seId: se } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  const fkExists = async (table: string, column: string, refTable: string): Promise<boolean> => {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = ${table}
        AND kcu.column_name = ${column} AND ccu.table_name = ${refTable}`;
    return Number(rows[0].n) >= 1;
  };

  it('has the FK to engineer_master', async () => {
    expect(await fkExists('se_availability', 'se_id', 'engineer_master')).toBe(true);
  });

  it('round-trips an ON_LEAVE window', async () => {
    const created = await prisma.seAvailability.create({
      data: { seId: se, status: 'ON_LEAVE', windowStart: new Date('2026-06-25T00:00:00Z'), windowEnd: new Date('2026-06-27T00:00:00Z'), reason: 'annual leave', setByRole: 'ZONAL_MANAGER' },
    });
    expect(created.status).toBe('ON_LEAVE');
    const found = await prisma.seAvailability.findUniqueOrThrow({ where: { id: created.id } });
    expect(found.windowEnd?.toISOString()).toBe('2026-06-27T00:00:00.000Z');
  });

  it('allows an open-ended window (null window_end)', async () => {
    const created = await prisma.seAvailability.create({
      data: { seId: se, status: 'SOFT_UNAVAILABLE', windowStart: new Date('2026-06-24T00:00:00Z'), windowEnd: null },
    });
    expect(created.windowEnd).toBeNull();
  });
});
