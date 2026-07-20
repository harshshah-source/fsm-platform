import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import type { AssertOptions, RawSqlClient } from './runtime-lock';

/**
 * #130 L4 — refuse a partial upgrade. Runs in the boot preamble BEFORE the L1 version lock: the app
 * bundle's `prisma/migrations/*` directory names must match the applied `_prisma_migrations` rows.
 * Catches the class L1's integer cannot: `migrate deploy` ran but the app was not upgraded (or the
 * reverse) — a schema/app skew that leaves the same version number.
 */

/** Pure set diff between what the app ships and what the database has applied. */
export function diffMigrations(bundled: string[], applied: string[]): { onlyInDb: string[]; onlyInApp: string[] } {
  const b = new Set(bundled);
  const a = new Set(applied);
  return {
    onlyInDb: applied.filter((name) => !b.has(name)).sort(),
    onlyInApp: bundled.filter((name) => !a.has(name)).sort(),
  };
}

/** Migration directory names shipped in the app bundle (excludes `migration_lock.toml` and stray files). */
export function readBundledMigrationNames(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** `apps/backend/prisma/migrations`, resolved the same from src (vitest) and dist (both `../../`). */
export function bundledMigrationsDir(): string {
  return path.join(__dirname, '..', '..', 'prisma', 'migrations');
}

/** Yields the applied migration names, or `null` when `_prisma_migrations` does not exist (R4 skip). */
export type AppliedMigrationsReader = () => Promise<string[] | null>;

/** Real reader: applied, successfully-finished, not-rolled-back migrations (R4 filters). */
export function prismaAppliedReader(client: RawSqlClient): AppliedMigrationsReader {
  return async () => {
    const exists = await client.$queryRawUnsafe<Array<{ present: string | null }>>(
      `SELECT to_regclass('_prisma_migrations')::text AS present`,
    );
    if (!exists[0]?.present) return null;

    const rows = await client.$queryRawUnsafe<Array<{ migration_name: string }>>(
      `SELECT migration_name FROM _prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    );
    return rows.map((row) => row.migration_name);
  };
}

export async function assertMigrationsInSync(
  readApplied: AppliedMigrationsReader,
  bundledNames: string[],
  opts: AssertOptions = {},
): Promise<void> {
  const emitWarn = opts.warn ?? ((message: string) => console.warn(message));

  const applied = await readApplied();
  if (applied === null) {
    emitWarn(
      'WARN migration-skew skipped: _prisma_migrations absent (a db-push / from-zero test DB has no migration ledger to compare).',
    );
    return;
  }

  const { onlyInDb, onlyInApp } = diffMigrations(bundledNames, applied);

  const refuse = (message: string): void => {
    if (opts.warnOnly) {
      emitWarn(message);
      return;
    }
    throw new Error(message);
  };

  if (onlyInDb.length > 0) {
    refuse(
      `FATAL migration-skew refused: the database has applied migration(s) this build does not bundle ` +
        `[${onlyInDb.join(', ')}] — this build is older than the schema. Deploy the current build.`,
    );
    if (opts.warnOnly) return; // warnOnly reported it; do not also report onlyInApp
  }

  if (onlyInApp.length > 0) {
    refuse(
      `FATAL migration-skew refused: this build bundles migration(s) not yet applied ` +
        `[${onlyInApp.join(', ')}] — run 'prisma migrate deploy' before starting.`,
    );
  }
}
