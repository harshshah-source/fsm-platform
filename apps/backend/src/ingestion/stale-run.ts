/**
 * Shared stale-run policy (Issue 97 Slice 2 / review A2).
 *
 * A process death mid-run leaves an orphaned `RUNNING` row; the partial-unique in-flight guard then
 * rejects every future run with 409 until it is cleared by hand. The reaper (implemented per run
 * table in `MasterSyncRunService` / `SnapshotRunService`, since their schemas differ) marks RUNNING
 * rows older than this threshold as FAILED before `startRun()` takes the lock — so unattended
 * operation recovers on its own. The threshold is the ONE shared piece; keep it well above the worst
 * real run time so a genuinely-slow-but-alive run is never reaped.
 */
export const DEFAULT_STALE_RUN_MIN = 30;

export const ORPHANED_RUN_ERROR = 'orphaned (process restart)';

/** Stale-run cutoff in milliseconds, env-overridable via `INGESTION_STALE_RUN_MIN` (minutes). */
export function readStaleRunMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.INGESTION_STALE_RUN_MIN);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_RUN_MIN;
  return minutes * 60_000;
}

/**
 * The liveness half of the reaper's `where`, shared by both run tables (#261, folding #132).
 *
 * `status` is deliberately not included: `snapshot_runs.status` is an enum and `master_sync_runs.status`
 * is a plain string, so the two callers spell that predicate themselves. What they must NOT spell
 * separately is this — the rule for *when a run counts as dead*, which used to be "started long ago"
 * and is now "has not said anything in a while":
 *
 *  - `heartbeat_at` older than the threshold → nothing has touched the run, reap it;
 *  - `heartbeat_at IS NULL` → a run written before the column existed, so fall back to `started_at`.
 *    Without this arm the reaper would silently stop working on exactly the rows it was built for.
 *
 * A run with a fresh beat is never reaped however long it has been running — that is the whole point.
 */
export function staleRunFilter(
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): { OR: [{ heartbeatAt: { lt: Date } }, { heartbeatAt: null; startedAt: { lt: Date } }] } {
  const cutoff = new Date(now.getTime() - readStaleRunMs(env));
  return { OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, startedAt: { lt: cutoff } }] };
}
