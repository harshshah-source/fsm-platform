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
