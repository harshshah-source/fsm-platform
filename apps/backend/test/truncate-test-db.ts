import type { PrismaClient } from '../src/generated/prisma/client';

/**
 * #180 R2 — single-statement `TRUNCATE ... RESTART IDENTITY`, no `CASCADE`, over every top-level
 * public base table. Table list is derived from `pg_class` (not `information_schema`) so no FK
 * topological sort has to be re-derived by hand on every migration.
 *
 * `relkind IN ('r','p')` takes ordinary + partitioned-parent tables and excludes the one
 * materialized view (`plant_eligible_floating_se` — cannot be truncated; the org seed's own
 * `REFRESH MATERIALIZED VIEW` repopulates it after this runs, see org-seed.ts).
 * `relispartition = false` skips `raw_device_snapshots`' daily child partitions — naming only the
 * parent lets `TRUNCATE` recurse into them instead of the list rotting every time a new daily
 * partition is created.
 * `spatial_ref_sys` is excluded because it is owned by the extension-installing superuser, not the
 * `fsm` role; naming it in the same statement as everything else would make the whole (atomic)
 * TRUNCATE roll back with a permission error (#156). `_prisma_migrations` is excluded because
 * truncating Prisma's own migration ledger makes the next `migrate deploy` replay full history.
 *
 * No `CASCADE`: every referencing table is already named in the same statement, so `CASCADE` is
 * redundant — and it is precisely the mechanism that could reach a table outside this intended set.
 */
const TABLE_LIST_QUERY = `
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname) AS qualified
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relispartition = false
    AND c.relname NOT IN ('spatial_ref_sys', '_prisma_migrations')
`;

/**
 * Refuses to run against anything but the isolated test database — this operation is unrecoverable.
 * Mirrors the derivation rule in `test/test-db-url.ts` (a `_test`-suffixed sibling of `DATABASE_URL`).
 */
function assertTestDatabase(databaseUrl: string): void {
  const dbName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `truncateTestDatabase refused: database name "${dbName}" does not end in "_test". ` +
        'Refusing to run a destructive TRUNCATE against what looks like a non-test database.',
    );
  }
}

/**
 * Must run AFTER `prisma migrate deploy` and BEFORE `seedOrgReferenceData` — the seed's own
 * unconditional `REFRESH MATERIALIZED VIEW` (org-seed.ts) is what repopulates
 * `plant_eligible_floating_se` after this empties every base table it reads from. Reversing the
 * order leaves the matview holding rows for base-table rows that no longer exist (#180 R4).
 *
 * Must be called with a bare `PrismaClient`, never `PrismaService` — constructing `PrismaService`
 * runs `assertRuntimeBuildGuards`, which writes `runtime_lock` and would falsely report drift against
 * a database this function is about to empty (#180 R2, #156, #153/#146 handoff §7.4).
 */
export async function truncateTestDatabase(prisma: PrismaClient, databaseUrl: string): Promise<void> {
  assertTestDatabase(databaseUrl);

  const rows = await prisma.$queryRawUnsafe<{ qualified: string | null }[]>(TABLE_LIST_QUERY);
  const tableList = rows[0]?.qualified;
  if (!tableList) return;

  await prisma.$executeRawUnsafe(`TRUNCATE ${tableList} RESTART IDENTITY`);
}
