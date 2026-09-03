-- #348 — give a snapshot run somewhere to record WHY it ended.
--
-- `SnapshotRunService.reapStaleRuns` flips an orphaned RUNNING row to FAILED when its heartbeat goes
-- stale (#261). Until now that was the entire record: the status changed, `finished_at` was stamped,
-- and nothing said the run had been reaped rather than having genuinely failed. In the run history an
-- operator therefore could not tell "the AutoPlant read threw" from "the process was restarted
-- mid-run" — two entries that look identical and call for completely different responses.
--
-- `master_sync_runs.error` has carried exactly this since Issue 97 (`ORPHANED_RUN_ERROR`), and the
-- snapshot reaper is a line-for-line twin of the master-sync one; the only reason it wrote no reason
-- was the missing column. This adds it, nullable and with no default, so every existing row is
-- untouched and honest: NULL means "written before runs recorded a reason", not "succeeded".

ALTER TABLE "snapshot_runs" ADD COLUMN "error" TEXT;
