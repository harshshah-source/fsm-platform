import * as os from 'node:os';
import type { BuildInfo } from './build-info';

/**
 * #130 L1 — build-fingerprint version lock. A build older than the database's recorded high-water
 * mark cannot start or write. Runs in every entrypoint's `PrismaService.onModuleInit` so no future
 * one-off script can forget it.
 */

/** Minimal Prisma surface the guard needs — a client that can run raw SQL. */
export interface RawSqlClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** A client that can open an interactive transaction (PrismaService satisfies this). */
export interface TransactionalClient extends RawSqlClient {
  $transaction<T>(fn: (tx: RawSqlClient) => Promise<T>): Promise<T>;
}

export interface AssertOptions {
  /** Read-only tools (autoplant:ping, departure-dryrun): evaluate + WARN, never write the lock, never throw. */
  warnOnly?: boolean;
  /** Injectable log sink (defaults to console) so tests can assert the WARN/refuse line. */
  warn?: (message: string) => void;
  /** The applied migration head (latest migration name) L4 resolved — recorded on the lock row for L3. */
  migrationHead?: string;
}

interface LockRow {
  version: bigint | number | string;
  fingerprint: string;
  boot_at: Date;
  pid: number | null;
  hostname: string | null;
  db: string;
}

/** The single fatal line the operator set as the bar (issue #130 L1). */
function refuseMessage(build: BuildInfo, row: LockRow): string {
  const dbVersion = Number(row.version);
  const bootedAt = row.boot_at instanceof Date ? row.boot_at.toISOString() : String(row.boot_at);
  return (
    `FATAL stale-build refused: this process is build ${build.fingerprint}@v${build.version}, ` +
    `but database ${row.db} requires ≥ v${dbVersion} ` +
    `(build ${row.fingerprint}, booted ${bootedAt} by pid${row.pid ?? '?'}@${row.hostname ?? '?'}). ` +
    `Deploy the current build or run 'npm run runtime-lock:reset' to authorize a rollback.`
  );
}

/** Take (or refresh) the high-water mark for this build. Upsert of the single enforced row. */
async function takeLock(client: RawSqlClient, build: BuildInfo, migrationHead: string | null): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO runtime_lock (id, version, fingerprint, app_version, migration_head, boot_at, pid, hostname, updated_at)
     VALUES (1, $1, $2, $3, $4, now(), $5, $6, now())
     ON CONFLICT (id) DO UPDATE SET
       version = EXCLUDED.version,
       fingerprint = EXCLUDED.fingerprint,
       app_version = EXCLUDED.app_version,
       migration_head = EXCLUDED.migration_head,
       boot_at = now(),
       pid = EXCLUDED.pid,
       hostname = EXCLUDED.hostname,
       updated_at = now()`,
    build.version,
    build.fingerprint,
    build.appVersion,
    migrationHead,
    process.pid,
    os.hostname(),
  );
}

const isDirtyFingerprint = (fingerprint: string): boolean => fingerprint.endsWith('-dirty');

/**
 * The decision + write, run on a single connection already holding the advisory lock. Throwing here
 * rolls the transaction back (no write ever happened on a refuse path). warnOnly warns and returns.
 */
async function decideAndApply(
  tx: RawSqlClient,
  build: BuildInfo,
  opts: AssertOptions,
  emitWarn: (message: string) => void,
): Promise<void> {
  const refuse = (row: LockRow): void => {
    const message = refuseMessage(build, row);
    if (opts.warnOnly) {
      emitWarn(message);
      return;
    }
    throw new Error(message);
  };

  const rows = await tx.$queryRawUnsafe<LockRow[]>(
    `SELECT version, fingerprint, boot_at, pid, hostname, current_database() AS db
     FROM runtime_lock WHERE id = 1`,
  );
  const row = rows[0];

  // No high-water mark yet (fresh DB) → own it.
  if (!row) {
    if (!opts.warnOnly) await takeLock(tx, build, opts.migrationHead ?? null);
    return;
  }

  const dbVersion = Number(row.version);

  // Newer build → normal deploy: advance the mark.
  if (build.version > dbVersion) {
    if (!opts.warnOnly) await takeLock(tx, build, opts.migrationHead ?? null);
    return;
  }

  // Older build → the exact July-19 stale process. Refuse.
  if (build.version < dbVersion) {
    refuse(row);
    return;
  }

  // Same version, same fingerprint → ordinary restart: refresh boot metadata.
  if (row.fingerprint === build.fingerprint) {
    if (!opts.warnOnly) await takeLock(tx, build, opts.migrationHead ?? null);
    return;
  }

  // Same version, differing fingerprints (R3). Refuse only when BOTH are clean SHAs — a true
  // ambiguity (two different commits with an identical committer second). If either side is dirty,
  // a same-HEAD dirty build is never *older* than HEAD, so take over with a loud WARN rather than
  // block routine local work.
  const eitherDirty = build.dirty || isDirtyFingerprint(build.fingerprint) || isDirtyFingerprint(row.fingerprint);
  if (!eitherDirty) {
    refuse(row);
    return;
  }

  emitWarn(
    `WARN runtime_lock takeover: build ${build.fingerprint}@v${build.version} takes the same-version ` +
      `lock from ${row.fingerprint} (a dirty worktree on one side is not older than HEAD).`,
  );
  if (!opts.warnOnly) await takeLock(tx, build, null);
}

export async function assertBuildNotStale(
  client: TransactionalClient,
  build: BuildInfo,
  opts: AssertOptions = {},
): Promise<void> {
  const emitWarn = opts.warn ?? ((message: string) => console.warn(message));

  // Serialize concurrent boots: hold pg_advisory_xact_lock for the whole read→decide→write critical
  // section (same pattern as master-sync-run.service.ts), so two boots can never lose an update and
  // leave an older build as the mark. The lock releases when the transaction commits or rolls back.
  await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('runtime_lock'))`);
    await decideAndApply(tx, build, opts, emitWarn);
  });
}
