import { getBuildInfo } from './build-info';
import {
  assertMigrationsInSync,
  bundledMigrationsDir,
  prismaAppliedReader,
  readBundledMigrationNames,
} from './migration-skew';
import { assertBuildNotStale, type AssertOptions, type TransactionalClient } from './runtime-lock';

/**
 * #130 — the boot preamble that runs in every entrypoint's `PrismaService.onModuleInit` (and, belt
 * and braces, early in `main.ts`). Ordered per the design: L4 schema-skew refusal BEFORE the L1
 * version lock, so a partial upgrade is caught before the version integer is even compared. L1 then
 * records the migration head on the lock row.
 *
 * Read-only tools pass `{ warnOnly: true }`: every refusal degrades to a WARN and no lock is written.
 */
export async function assertRuntimeBuildGuards(
  client: TransactionalClient,
  opts: AssertOptions = {},
): Promise<void> {
  const bundled = readBundledMigrationNames(bundledMigrationsDir());

  // L4 — schema skew (both directions; skips when _prisma_migrations is absent).
  await assertMigrationsInSync(prismaAppliedReader(client), bundled, opts);

  // L1 — version lock. The migration head (latest applied name) is stamped onto the lock row for L3.
  const migrationHead = bundled.length > 0 ? [...bundled].sort().at(-1) : undefined;
  await assertBuildNotStale(client, getBuildInfo(), { ...opts, migrationHead });
}
