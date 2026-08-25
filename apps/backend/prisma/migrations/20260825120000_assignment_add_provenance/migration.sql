-- #283 — the add side of an assignment learns who, why and through which door.
--
-- `batch_assignment_tickets` has recorded the END of an assignment since #241 (removed_at,
-- removed_by, removal_reason) and recorded NOTHING about its start: all four writers set only
-- (batch_id, ticket_id, sort_order). So "who put this ticket on this plan" was answerable only by
-- joining audit_logs — and on the intraday CRITICAL path not even then, because the engine and a ZM
-- both audit as CRITICAL_ASSIGN. That gap is what made the approved provenance grammar (#282 R2,
-- "a human decision never looks like a system one") unrenderable.
--
-- TEXT rather than Postgres enums, deliberately: the same posture removal_reason takes at
-- schema.prisma:721-724 — later slices add members without a schema migration, and the closed set is
-- enforced in TypeScript (src/scheduling/add-source.ts).
--
-- All four columns are nullable and NOT backfilled. A pre-#283 row genuinely does not record who
-- added it; guessing would be a fabrication. NULL means "unknown", and readers must never render it
-- as a system decision — that is the one direction that would break the grammar's promise.
--
-- Deliberately NOT part of this migration: a new `batch_status` value for manual batches. Seven
-- production readers use status IN ('AUTO_ASSIGNED','OVERRIDDEN') as the *live batch* predicate, so
-- adding a member would silently drop every manual batch out of "live" in all seven. `status` is a
-- lifecycle column (COMPLETED/PARTIAL prove it); provenance belongs on the ticket row.

ALTER TABLE "batch_assignment_tickets"
  ADD COLUMN "added_by" UUID,
  ADD COLUMN "add_reason" TEXT,
  ADD COLUMN "add_source" TEXT,
  ADD COLUMN "coverage_type_at_assign" TEXT;

COMMENT ON COLUMN "batch_assignment_tickets"."added_by" IS
  'Who added the row (#283). NULL for engine writes by construction and for pre-#283 history.';
COMMENT ON COLUMN "batch_assignment_tickets"."add_reason" IS
  'Human reason for the add where the door required one; never invented.';
COMMENT ON COLUMN "batch_assignment_tickets"."add_source" IS
  'Which door the work came through — one of ADD_SOURCES (src/scheduling/add-source.ts).';
COMMENT ON COLUMN "batch_assignment_tickets"."coverage_type_at_assign" IS
  'Chosen SE coverage of this plant AT WRITE TIME — DEDICATED/MULTI_PLANT/FLOATING/NONE. The
   tier-crossing signal; stamped rather than derived because se_coverage is mutable and hard-deleted.';
