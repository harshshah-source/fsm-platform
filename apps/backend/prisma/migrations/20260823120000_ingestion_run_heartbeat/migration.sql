-- #261 (folding #132) — liveness on the ingestion ledgers is a heartbeat, not a start time.
--
-- The #97 reaper judged staleness from `started_at` alone, so a run that is merely SLOW looks exactly
-- like a run whose process died. The master sync legitimately runs long against AutoPlant; reaping it
-- both loses its result and frees the in-flight guard for a second sync to start over the top of the
-- first. `heartbeat_at` is what the run itself touches at each pipeline stage, so "nothing has touched
-- this in N minutes" becomes answerable without guessing how long a healthy run should take.
--
-- Nullable, no default: every row written before this column existed never beat, and the reaper falls
-- back to `started_at` for exactly those. A DEFAULT now() would silently re-date them.
ALTER TABLE "snapshot_runs" ADD COLUMN "heartbeat_at" TIMESTAMPTZ(6);
ALTER TABLE "master_sync_runs" ADD COLUMN "heartbeat_at" TIMESTAMPTZ(6);
