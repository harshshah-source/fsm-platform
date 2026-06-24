import { PrismaService } from '../src/prisma/prisma.service';

/**
 * TB10 — the migration applies clean against the local Postgres and the foundational
 * `system_settings` table exists. Verified through the public PrismaService surface
 * (a real connection + raw catalogue query), not by shelling out to psql.
 */
describe('TB10 — Prisma migration', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('connects to the database', async () => {
    const rows = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
    expect(rows[0].ok).toBe(1);
  });

  it('has the system_settings table from a clean migration', async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'system_settings'`;
    expect(rows).toHaveLength(1);
  });
});
