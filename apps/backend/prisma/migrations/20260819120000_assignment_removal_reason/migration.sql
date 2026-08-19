-- #241 — why a batch assignment row stopped being live.
--
-- `batch_assignment_tickets` recorded only WHEN a row was removed and BY WHOM, and `removed_by IS
-- NULL` was already spoken for: auto-recovery removes rows with a NULL actor, 1,092 of them in the
-- dev mirror. So nothing distinguished a ZM withdrawal from a deferral from a device that left the
-- fleet — and three slices that follow need exactly that distinction and cannot recover it later:
--
--   #242 recycles rows that expired unworked (PLAN_EXPIRED) and must never touch the others;
--   #243's one-off cleanup needs a marker that is also its rollback handle (DEV_CLEANUP);
--   #244 counts an assignment as an unsuccessful *attempt* only for specific end causes.
--
-- TEXT, not an enum, on purpose: the later slices add members without another schema migration, and
-- the closed vocabulary is enforced in one place in TypeScript (`scheduling/removal-reason.ts`).
-- Additive and nullable throughout — rollback is dropping the column.

ALTER TABLE "batch_assignment_tickets"
  ADD COLUMN "removal_reason" TEXT;

-- Backfill history so the invariant "removed ⇒ has a reason" is true from this migration onward
-- rather than only for rows written after it. Idempotent (`WHERE removal_reason IS NULL`), so a
-- re-run is a no-op and the statement is safe to replay against a partially-migrated database.
--
-- Only two causes are recoverable from the old columns, and that is enough. `removed_by IS NULL` is
-- auto-recovery's signature — the sole system remover before this slice. Everything else was a human
-- action, and a deferral is the one human action that left its own evidence (`deferred_to_date`).
-- Withdraw / reassign-source / bulk-unassign are not separable retroactively and do not need to be:
-- #244 excludes all three from attempt counting identically, so the distinction would decide nothing.
UPDATE "batch_assignment_tickets"
   SET "removal_reason" = CASE
         WHEN "removed_by" IS NULL              THEN 'AUTO_RECOVERY'
         WHEN "deferred_to_date" IS NOT NULL    THEN 'ZM_DEFERRED'
         ELSE                                        'HUMAN_REMOVED'
       END
 WHERE "removed_at" IS NOT NULL
   AND "removal_reason" IS NULL;

-- The per-ticket assignment history read. #244 walks a ticket's attempt windows; today that query has
-- no usable index — the table carries only `(batch_id)` and the live-row partial unique
-- `(ticket_id) WHERE removed_at IS NULL`, which a history read (removed rows included) cannot use.
CREATE INDEX "batch_assignment_tickets_ticket_id_idx"
  ON "batch_assignment_tickets" ("ticket_id");

-- Reached-evidence lookup: a soft state counts toward an attempt when its `set_at` falls inside that
-- assignment window, so the join is per ticket, ordered by time. `(se_id, resolved_at)` was the only
-- index and serves the SE's own live view, not this.
CREATE INDEX "soft_states_ticket_id_set_at_idx"
  ON "soft_states" ("ticket_id", "set_at");
