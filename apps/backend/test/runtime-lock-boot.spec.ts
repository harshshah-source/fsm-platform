import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { getBuildInfo } from '../src/build-info/build-info';

/**
 * #130 L1/L4 wiring — the guard is structural: it lives in `PrismaService.onModuleInit`, so every
 * entrypoint (Nest app + hand-constructed scripts) runs it and no future script can forget it.
 *
 * This file mutates the shared `runtime_lock`; it cleans up to a fresh (empty) state so the rest of
 * the serial suite boots normally (an orphaned high mark would refuse every later boot).
 */
describe('PrismaService boot guard', () => {
  let raw: PrismaService;

  beforeAll(async () => {
    raw = new PrismaService();
    await raw.$connect();
  });

  afterEach(async () => {
    await raw.$executeRawUnsafe('DELETE FROM runtime_lock');
  });

  afterAll(async () => {
    await raw.$executeRawUnsafe('DELETE FROM runtime_lock');
    await raw.$disconnect();
  });

  it('onModuleInit takes the runtime lock for this build (source-run git stamp)', async () => {
    await raw.$executeRawUnsafe('DELETE FROM runtime_lock');

    const prisma = new PrismaService();
    await prisma.onModuleInit();

    const rows = await raw.$queryRawUnsafe<Array<{ v: string; f: string }>>(
      'SELECT version::text AS v, fingerprint AS f FROM runtime_lock WHERE id = 1',
    );
    const build = getBuildInfo();
    expect(rows[0]?.v).toBe(String(build.version));
    expect(rows[0]?.f).toBe(build.fingerprint);

    await prisma.onModuleDestroy();
  });

  it('a warnOnly PrismaService does not throw or write against a higher mark (read-only tools)', async () => {
    await raw.$executeRawUnsafe(
      `INSERT INTO runtime_lock (id, version, fingerprint, app_version, migration_head, boot_at, pid, hostname, updated_at)
       VALUES (1, 9999999999, 'future1', '9.9.9', 'head', now(), 4242, 'db-host', now())`,
    );

    const tool = new PrismaService({ warnOnly: true });
    await expect(tool.onModuleInit()).resolves.toBeUndefined();

    const rows = await raw.$queryRawUnsafe<Array<{ v: string }>>('SELECT version::text AS v FROM runtime_lock WHERE id = 1');
    expect(rows[0]?.v).toBe('9999999999'); // untouched by the read-only tool

    await tool.onModuleDestroy();
  });
});
