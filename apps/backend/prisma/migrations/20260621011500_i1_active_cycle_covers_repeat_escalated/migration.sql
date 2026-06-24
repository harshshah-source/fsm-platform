-- Issue 08, slice 5a — widen invariant I1 to cover REPEAT and ESCALATED.
--
-- The active-episode set originally guarded only OPEN/WAITING_COMPONENT/SUBMITTED (the cycle-creation
-- states). But a REPEAT cycle is the device's current repeat episode (opened with an OPEN ticket), and
-- an ESCALATED cycle is a still-down device flagged to ZM+WM (LLD §10.2 — ESCALATED is not a closed
-- ticket status). Both are active episodes: a device must not hold two simultaneously. The DB partial-
-- unique is the final guard behind the `has_open_failure_cycle` application fast-path.
--
-- VERIFIED and FAILED remain excluded — those are genuine closures and must allow a fresh episode.

DROP INDEX "failure_cycles_one_active_per_device";

CREATE UNIQUE INDEX "failure_cycles_one_active_per_device"
  ON "failure_cycles" ("device_id")
  WHERE "state" IN ('OPEN', 'WAITING_COMPONENT', 'SUBMITTED', 'REPEAT', 'ESCALATED');
