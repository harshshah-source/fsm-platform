-- #261 — a dead dispatch process must not hold a zone forever.
--
-- #259 made admission a `dispatch_run_zones` row, which is what made a refusal durable across
-- processes. Durability cuts both ways: `releaseStrandedClaims` finalizes the claims of a run that
-- UNWINDS, but a process that DIES never reaches a `finally`, and the RUNNING claim it leaves behind
-- refuses that zone to every future run for the rest of the database's life. The two columns below are
-- what let a later admission tell that wreckage apart from a run that is merely still working.

-- Liveness is a beat, not an age. A dispatch run walks every active zone and is legitimately long;
-- keying staleness on `started_at` would hand a live run's zones to a second run mid-dispatch. NULL for
-- every run that predates the column — `staleDispatchRunFilter` falls back to `started_at` for those,
-- which is the old behaviour and is correct for rows that can no longer be alive anyway.
ALTER TABLE "dispatch_runs" ADD COLUMN "heartbeat_at" TIMESTAMPTZ(6);

-- A reaped run is not FAILED. FAILED means the run tried every zone and every one of them failed — a
-- statement about the work. ABORTED means nobody knows what the run did, because whoever was running it
-- stopped existing. Collapsing them would make "the dispatcher is broken" and "the box was restarted"
-- the same row on the transparency list.
ALTER TYPE "dispatch_run_status" ADD VALUE 'ABORTED';
