import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { assertBuildNotStale } from '../src/build-info/runtime-lock';
import { parseResetArgs, resetRuntimeLock } from '../src/build-info/runtime-lock-reset';

/**
 * #130 L1 downgrade path — `runtime-lock:reset` is the ONLY way to lower the high-water mark. It is
 * dry-run by default (prints intent, changes nothing) and requires `--yes` to apply; every apply
 * writes a RUNTIME_LOCK_RESET audit row. Tested at the `resetRuntimeLock` core + `parseResetArgs`.
 */
describe('parseResetArgs', () => {
  it('parses --to, --reason and --yes', () => {
    expect(parseResetArgs(['--to', '123', '--reason', 'rollback botched deploy', '--yes'])).toEqual({
      to: 123,
      reason: 'rollback botched deploy',
      confirmed: true,
    });
  });

  it('defaults confirmed to false when --yes is absent', () => {
    expect(parseResetArgs(['--to', '123', '--reason', 'x']).confirmed).toBe(false);
  });

  it('rejects a missing/non-numeric --to', () => {
    expect(() => parseResetArgs(['--reason', 'x'])).toThrow(/--to/);
    expect(() => parseResetArgs(['--to', 'abc'])).toThrow(/--to/);
  });

  it('requires a --reason', () => {
    expect(() => parseResetArgs(['--to', '123'])).toThrow(/--reason/);
  });
});

describe('resetRuntimeLock — core', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });
  const cleanup = async (): Promise<void> => {
    await prisma.$executeRawUnsafe('DELETE FROM runtime_lock');
    await prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE action = 'RUNTIME_LOCK_RESET'`);
  };
  // Clean both before AND after each test: the `_test` DB persists across runs, so a row left by an
  // earlier crashed run would otherwise fail the "writes no audit row" count assertion.
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const seed = (version: number): Promise<number> =>
    prisma.$executeRawUnsafe(
      `INSERT INTO runtime_lock (id, version, fingerprint, app_version, migration_head, boot_at, pid, hostname, updated_at)
       VALUES (1, ${version}, 'clean01', '0.0.1', 'head', now(), 1, 'h', now())`,
    );

  const lockVersion = async (): Promise<string | null> => {
    const rows = await prisma.$queryRawUnsafe<Array<{ v: string }>>('SELECT version::text AS v FROM runtime_lock WHERE id = 1');
    return rows[0]?.v ?? null;
  };

  it('dry-run (no --yes) changes nothing and writes no audit row', async () => {
    await seed(200);
    const out: string[] = [];

    const result = await resetRuntimeLock(prisma, { to: 100, reason: 'x', confirmed: false }, (m) => out.push(m));

    expect(result.applied).toBe(false);
    expect(await lockVersion()).toBe('200'); // untouched
    const audits = await prisma.$queryRawUnsafe<Array<{ n: string }>>(
      `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'RUNTIME_LOCK_RESET'`,
    );
    expect(audits[0].n).toBe('0');
    expect(out.join('\n')).toMatch(/dry run/i);
  });

  it('applies with --yes: lowers the mark and writes a RUNTIME_LOCK_RESET audit row (from→to, reason)', async () => {
    await seed(200);

    const result = await resetRuntimeLock(
      prisma,
      { to: 100, reason: 'authorize rollback', confirmed: true, actorId: 'ops:alice' },
      () => undefined,
    );

    expect(result.applied).toBe(true);
    expect(result.previousVersion).toBe(200);
    expect(await lockVersion()).toBe('100');

    const audits = await prisma.$queryRawUnsafe<Array<{ action: string; entity_type: string; metadata: unknown }>>(
      `SELECT action, entity_type, metadata FROM audit_logs WHERE action = 'RUNTIME_LOCK_RESET'`,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].entity_type).toBe('runtime_lock');
    expect(audits[0].metadata).toMatchObject({ from: 200, to: 100, reason: 'authorize rollback', actor: 'ops:alice' });
  });

  it('after a reset, a build at the new (lower) version can boot again (rollback authorized)', async () => {
    await seed(200); // a v200 build owns the mark
    // A v100 build would normally be refused:
    await expect(
      assertBuildNotStale(prisma, { version: 100, fingerprint: 'oldsha', dirty: false, appVersion: '0.0.1' }),
    ).rejects.toThrow(/stale-build refused/i);

    // Operator authorizes the rollback to v100:
    await resetRuntimeLock(prisma, { to: 100, reason: 'rollback', confirmed: true }, () => undefined);

    // Now the v100 build boots (takes over the administratively-reset mark) without throwing:
    await expect(
      assertBuildNotStale(prisma, { version: 100, fingerprint: 'oldsha', dirty: false, appVersion: '0.0.1' }),
    ).resolves.toBeUndefined();
  });
});
