import { PrismaService } from '../prisma/prisma.service';
import type { RawSqlClient } from './runtime-lock';

/**
 * #130 L1 — the ONLY path that lowers the runtime-lock high-water mark (authorizes a rollback).
 * Dry-run by default; `--yes` applies and writes a RUNTIME_LOCK_RESET audit row. The CLI constructs
 * PrismaService in warnOnly mode — it exists to repair lock state, so it must never be blocked by it.
 */

export interface ResetArgs {
  to: number;
  reason: string;
  confirmed: boolean;
}

export function parseResetArgs(argv: string[]): ResetArgs {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };

  const rawTo = flag('--to');
  const to = Number(rawTo);
  if (rawTo === undefined || !Number.isFinite(to)) {
    throw new Error("runtime-lock:reset requires a numeric --to <version> (the build version to lower the mark to).");
  }

  const reason = flag('--reason');
  if (!reason) {
    throw new Error('runtime-lock:reset requires --reason "<text>" (recorded on the audit row).');
  }

  return { to, reason, confirmed: argv.includes('--yes') };
}

export interface ResetParams extends ResetArgs {
  /** Who authorized the reset — recorded on the audit row. Defaults to a system identity. */
  actorId?: string;
}

export interface ResetResult {
  previousVersion: number | null;
  requestedVersion: number;
  applied: boolean;
}

export async function resetRuntimeLock(
  client: RawSqlClient,
  params: ResetParams,
  emit: (message: string) => void = (m) => console.log(m),
): Promise<ResetResult> {
  const rows = await client.$queryRawUnsafe<Array<{ version: string }>>(
    'SELECT version::text AS version FROM runtime_lock WHERE id = 1',
  );
  const previousVersion = rows[0] ? Number(rows[0].version) : null;
  const actorId = params.actorId ?? 'system:runtime-lock-reset';

  if (!params.confirmed) {
    emit(
      `[runtime-lock:reset] DRY RUN — would lower the mark from v${previousVersion ?? '(none)'} to ` +
        `v${params.to} (reason: ${params.reason}). Re-run with --yes to apply. Nothing changed.`,
    );
    return { previousVersion, requestedVersion: params.to, applied: false };
  }

  // Apply. The fingerprint sentinel carries a `-dirty` suffix on purpose: it marks the mark as
  // administratively reset, so the rolled-back build booting at exactly this version *takes over*
  // (R3 dirty-takeover) instead of hitting the clean-clean ambiguity refusal.
  await client.$executeRawUnsafe(
    `INSERT INTO runtime_lock (id, version, fingerprint, app_version, migration_head, boot_at, pid, hostname, updated_at)
     VALUES (1, $1, 'reset-dirty', 'reset', NULL, now(), NULL, NULL, now())
     ON CONFLICT (id) DO UPDATE SET
       version = EXCLUDED.version, fingerprint = EXCLUDED.fingerprint, app_version = EXCLUDED.app_version,
       boot_at = now(), pid = NULL, hostname = NULL, updated_at = now()`,
    params.to,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO audit_logs (actor_id, actor_role, action, entity_type, entity_id, metadata, created_at)
     VALUES ($1, 'SYSTEM', 'RUNTIME_LOCK_RESET', 'runtime_lock', '1', $2::jsonb, now())`,
    actorId,
    JSON.stringify({ from: previousVersion, to: params.to, reason: params.reason, actor: actorId }),
  );

  emit(
    `[runtime-lock:reset] lock lowered v${previousVersion ?? '(none)'} → v${params.to}. ` +
      `Audit row written (RUNTIME_LOCK_RESET by ${actorId}).`,
  );
  return { previousVersion, requestedVersion: params.to, applied: true };
}

/** CLI entrypoint: parse args, run in warnOnly mode, exit non-zero on a dry run so scripts can gate. */
export async function runResetCli(argv: string[]): Promise<number> {
  let args: ResetArgs;
  try {
    args = parseResetArgs(argv);
  } catch (err) {
    console.error(`[runtime-lock:reset] ${(err as Error).message}`);
    return 2;
  }

  const prisma = new PrismaService({ warnOnly: true });
  try {
    await prisma.onModuleInit();
    const result = await resetRuntimeLock(prisma, { ...args, actorId: process.env.USER ?? process.env.USERNAME });
    return result.applied ? 0 : 1; // dry run exits non-zero: nothing was changed
  } finally {
    await prisma.onModuleDestroy();
  }
}

if (require.main === module) {
  void runResetCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[runtime-lock:reset] failed: ${(err as Error).message}`);
      process.exit(3);
    },
  );
}
