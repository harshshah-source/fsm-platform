import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  assertMigrationsInSync,
  diffMigrations,
  prismaAppliedReader,
  readBundledMigrationNames,
  bundledMigrationsDir,
} from '../src/build-info/migration-skew';

/**
 * #130 L4 — refuse a partial upgrade: the app's bundled `prisma/migrations/*` must match the applied
 * `_prisma_migrations` rows. Pure diff + injectable applied-reader (so the "table absent" skip is
 * deterministic) + one integration check against the real `_test` DB (migrate-deployed = exact match).
 */
describe('diffMigrations', () => {
  it('reports migrations present only in the DB (app older than schema)', () => {
    expect(diffMigrations(['a', 'b'], ['a', 'b', 'c'])).toEqual({ onlyInDb: ['c'], onlyInApp: [] });
  });

  it('reports migrations present only in the app (schema behind app)', () => {
    expect(diffMigrations(['a', 'b', 'c'], ['a', 'b'])).toEqual({ onlyInDb: [], onlyInApp: ['c'] });
  });

  it('reports an exact match as no diff', () => {
    expect(diffMigrations(['a', 'b'], ['b', 'a'])).toEqual({ onlyInDb: [], onlyInApp: [] });
  });
});

describe('assertMigrationsInSync — decisions', () => {
  const applied = ['20240101000000_init', '20240102000000_next'];
  const reader = (names: string[] | null) => async () => names;

  it('proceeds when bundled and applied match exactly', async () => {
    await expect(assertMigrationsInSync(reader(applied), [...applied])).resolves.toBeUndefined();
  });

  it('refuses when the DB has a migration the app does not bundle (app older than schema)', async () => {
    await expect(
      assertMigrationsInSync(reader([...applied, '20240103000000_extra']), [...applied]),
    ).rejects.toThrow(/older than the schema/i);
  });

  it('refuses when the app bundles a migration not yet applied (run migrate deploy first)', async () => {
    await expect(
      assertMigrationsInSync(reader(applied), [...applied, '20240103000000_pending']),
    ).rejects.toThrow(/migrate deploy/i);
  });

  it('skips with a warn when _prisma_migrations is absent (db push / from-zero test DB)', async () => {
    const warns: string[] = [];
    await expect(
      assertMigrationsInSync(reader(null), ['whatever'], { warn: (m) => warns.push(m) }),
    ).resolves.toBeUndefined();
    expect(warns.join('\n')).toMatch(/_prisma_migrations/);
  });

  it('warnOnly: a skew warns but never throws', async () => {
    const warns: string[] = [];
    await expect(
      assertMigrationsInSync(reader([...applied, '20240103000000_extra']), [...applied], {
        warnOnly: true,
        warn: (m) => warns.push(m),
      }),
    ).resolves.toBeUndefined();
    expect(warns.join('\n')).toMatch(/migration-skew/i);
  });
});

describe('assertMigrationsInSync — against the real migrate-deployed test DB', () => {
  let prisma: PrismaService;
  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('proceeds: the bundled migrations exactly equal what migrate deploy applied', async () => {
    const bundled = readBundledMigrationNames(bundledMigrationsDir());
    expect(bundled).toContain('20260720120000_runtime_lock'); // this slice's own migration is bundled
    await expect(assertMigrationsInSync(prismaAppliedReader(prisma), bundled)).resolves.toBeUndefined();
  });
});
