-- The remove side of an assignment learns the words the operator was made to type.
--
-- The add side has recorded them since #283 (`add_reason`, "the human reason for the add, where the
-- door required one"). The remove side had nowhere to put them, and the two doors are symmetric: every
-- override the Console offers — REMOVE_TICKET, DEFER_TICKET, the source half of a REASSIGN — *refuses
-- to commit without a reason*, and then published none. An operator deferred three devices with three
-- different explanations and the Changes tab showed their name three times followed by nothing.
--
-- The words could not go anywhere that already existed:
--
--   * `removal_reason` is a CLOSED VOCABULARY read as a predicate (#241, and the docblock on
--     src/scheduling/removal-reason.ts is explicit about why). #244 counts repair attempts off it, so
--     free text there would silently change an operational classification rather than produce a
--     visible mistake. It stays exactly what it is.
--   * `plant_batch_assignments.override_reason` is BATCH-level and last-writer-wins. Measured on the
--     dev mirror after the three defers above: batch 1502 held one string, and not the first two.
--
-- So: a nullable TEXT column beside `removal_reason`, carrying the sentence while the vocabulary
-- carries the predicate. Both, never either.
--
-- NOT backfilled, and that is the honest choice: a pre-existing removed row genuinely does not record
-- what its actor typed (it is recoverable only from audit_logs.metadata, an append-only compliance
-- store and not an operational read source). NULL means "no reason recorded", which readers already
-- render as absence — never as a system removal, and never invented.

ALTER TABLE "batch_assignment_tickets"
  ADD COLUMN "removal_note" TEXT;

COMMENT ON COLUMN "batch_assignment_tickets"."removal_note" IS
  'The human reason for the removal, where the door required one — symmetric with add_reason.
   removal_reason stays the closed predicate vocabulary; this carries the operator''s own words.
   NULL = no reason recorded (system removals, and all pre-migration history).';
