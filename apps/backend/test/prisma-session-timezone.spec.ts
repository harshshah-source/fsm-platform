import { PrismaService } from '../src/prisma/prisma.service';

/**
 * ADR-0025 (timestamptz-UTC) regression guard. A 2026-07-07 production validation audit found the
 * Postgres server default TimeZone on `Asia/Calcutta`, which renders every timestamptz as IST text
 * (+05:30) — the exact 5.5h that made stored-vs-displayed inactivity look "drifted" even though the
 * stored instants are correct. `PrismaService` pins the *session* TimeZone to UTC on the connection it
 * owns (`options: '-c timezone=UTC'`), so no server default can reintroduce that offset. Interval
 * arithmetic (`now - latest_gps_datetime`) is TZ-independent regardless; this locks the display/`::timestamp`
 * surface to UTC as well. If this ever fails, the app connection has lost its UTC pin.
 */
describe('PrismaService — ADR-0025 session TimeZone pin', () => {
  it('resolves the session TimeZone to UTC regardless of the server default', async () => {
    const prisma = new PrismaService();
    await prisma.onModuleInit();
    try {
      const rows = await prisma.$queryRawUnsafe<{ TimeZone: string }[]>('SHOW TimeZone');
      expect(rows[0]?.TimeZone).toBe('UTC');
    } finally {
      await prisma.onModuleDestroy();
    }
  });
});
