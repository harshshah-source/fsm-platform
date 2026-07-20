import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { assertBuildNotStale } from '../src/build-info/runtime-lock';
import type { BuildInfo } from '../src/build-info/build-info';

/**
 * #130 L1 — build-fingerprint version lock. Tested at the `assertBuildNotStale` seam against the
 * isolated `_test` DB (setup-env re-points DATABASE_URL): the lock uses a real row + advisory lock,
 * so a mock would test nothing. BuildInfo is injected, so the resolver's env-sniffing is out of scope.
 */
describe('assertBuildNotStale — L1 version lock', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    // Raw $connect — NOT onModuleInit — so constructing the client here does not itself run the guard.
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM runtime_lock');
  });

  const build = (over: Partial<BuildInfo> = {}): BuildInfo => ({
    version: 100,
    fingerprint: 'bbbbbbb',
    dirty: false,
    appVersion: '0.0.1',
    ...over,
  });

  const seedLock = (version: number, fingerprint = 'aaaaaaa'): Promise<number> =>
    prisma.$executeRawUnsafe(
      `INSERT INTO runtime_lock (id, version, fingerprint, app_version, migration_head, boot_at, pid, hostname, updated_at)
       VALUES (1, ${version}, '${fingerprint}', '0.0.1', 'head', now(), 4242, 'db-host', now())`,
    );

  const readLock = (): Promise<Array<{ version: string; fingerprint: string; pid: number | null }>> =>
    prisma.$queryRawUnsafe(`SELECT version::text AS version, fingerprint, pid FROM runtime_lock WHERE id = 1`);

  it('refuses a build older than the database high-water mark, naming both versions', async () => {
    await seedLock(200, 'aaaaaaa');

    await expect(assertBuildNotStale(prisma, build({ version: 100, fingerprint: 'bbbbbbb' }))).rejects.toThrow(
      /stale-build refused/i,
    );
  });

  it('owns the lock when no high-water mark exists yet (fresh DB)', async () => {
    await assertBuildNotStale(prisma, build({ version: 150, fingerprint: 'ccccccc' }));

    const [row] = await readLock();
    expect(row).toBeDefined();
    expect(row.version).toBe('150');
    expect(row.fingerprint).toBe('ccccccc');
    expect(row.pid).toBe(process.pid);
  });

  it('upgrades the high-water mark when this build is newer (normal deploy)', async () => {
    await seedLock(100, 'aaaaaaa');

    await assertBuildNotStale(prisma, build({ version: 200, fingerprint: 'ddddddd' }));

    const [row] = await readLock();
    expect(row.version).toBe('200');
    expect(row.fingerprint).toBe('ddddddd');
  });

  it('refreshes boot metadata on a same-version, same-fingerprint restart', async () => {
    await seedLock(100, 'eeeeeee');

    await assertBuildNotStale(prisma, build({ version: 100, fingerprint: 'eeeeeee' }));

    const [row] = await readLock();
    expect(row.version).toBe('100');
    expect(row.fingerprint).toBe('eeeeeee');
    expect(row.pid).toBe(process.pid); // took over the boot metadata
  });

  it('refuses same-version but different clean fingerprints (true ambiguity — two commits, same second)', async () => {
    await seedLock(100, 'clean01');

    await expect(
      assertBuildNotStale(prisma, build({ version: 100, fingerprint: 'clean02', dirty: false })),
    ).rejects.toThrow(/stale-build refused/i);

    const [row] = await readLock();
    expect(row.fingerprint).toBe('clean01'); // lock NOT taken over
  });

  it('warns and takes over on same-version when THIS build is dirty (routine local rebuild, R3)', async () => {
    await seedLock(100, 'clean01');
    const warns: string[] = [];

    await assertBuildNotStale(prisma, build({ version: 100, fingerprint: 'sha99-dirty', dirty: true }), {
      warn: (m) => warns.push(m),
    });

    expect(warns.join('\n')).toMatch(/runtime.lock/i);
    const [row] = await readLock();
    expect(row.fingerprint).toBe('sha99-dirty'); // took over
    expect(row.pid).toBe(process.pid);
  });

  it('warns and takes over on same-version when the STORED build was dirty (R3)', async () => {
    await seedLock(100, 'stored-dirty');
    const warns: string[] = [];

    await assertBuildNotStale(prisma, build({ version: 100, fingerprint: 'clean02', dirty: false }), {
      warn: (m) => warns.push(m),
    });

    expect(warns.length).toBeGreaterThan(0);
    const [row] = await readLock();
    expect(row.fingerprint).toBe('clean02'); // took over
  });

  it('warnOnly: an older build warns but never throws and never writes the lock (read-only tools)', async () => {
    await seedLock(200, 'aaaaaaa');
    const warns: string[] = [];

    await expect(
      assertBuildNotStale(prisma, build({ version: 100, fingerprint: 'bbbbbbb' }), {
        warnOnly: true,
        warn: (m) => warns.push(m),
      }),
    ).resolves.toBeUndefined();

    expect(warns.join('\n')).toMatch(/stale-build refused/i);
    const [row] = await readLock();
    expect(row.version).toBe('200'); // untouched
    expect(row.fingerprint).toBe('aaaaaaa');
  });

  it('the refuse message names build, db, required version, and the booting pid@host', async () => {
    await seedLock(200, 'aaaaaaa'); // seedLock writes pid 4242, hostname db-host

    await assertBuildNotStale(prisma, build({ version: 100, fingerprint: 'bbbbbbb' })).then(
      () => {
        throw new Error('expected a refuse');
      },
      (err: Error) => {
        expect(err.message).toContain('stale-build refused');
        expect(err.message).toContain('build bbbbbbb@v100');
        expect(err.message).toMatch(/requires ≥ v200/);
        expect(err.message).toContain('build aaaaaaa');
        expect(err.message).toContain('pid4242@db-host');
        expect(err.message).toContain('runtime-lock:reset');
      },
    );
  });

  it('serializes concurrent boots so the newest build wins the mark (advisory lock, no lost update)', async () => {
    // Fresh DB: two boots race to own the mark. Without serialization a lost update could leave the
    // OLDER build as the mark (both read empty, both insert, last writer wins). The advisory lock
    // forces one to observe the other, so the newer build always ends as the mark and the older refuses.
    const older = assertBuildNotStale(prisma, build({ version: 150, fingerprint: 'aaa150' })).catch((e) => e);
    const newer = assertBuildNotStale(prisma, build({ version: 200, fingerprint: 'bbb200' })).catch((e) => e);
    await Promise.all([older, newer]);

    const [row] = await readLock();
    expect(row.version).toBe('200');
    expect(row.fingerprint).toBe('bbb200');
  });
});
