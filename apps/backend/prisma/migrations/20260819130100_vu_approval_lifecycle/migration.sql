-- #245 — the vehicle-unavailability report becomes the system of record for the return-date decision.
--
-- Corrects a claim this table has carried since `20260624220000_add_vehicle_unavailability`: that
-- "the Ticket resurfaces at the expected-availability date". It never did — nothing read
-- `expected_from` at all. #246 makes the claim true; this migration gives it something trustworthy
-- to read, because until now the one date column was mutable in place by `confirmDate` with no
-- audit row and no history, so "the date the SE proposed" was destroyed by the first manager edit.
--
-- Q1(a), recorded on the issue: the SE's proposed date takes effect immediately as a provisional
-- deferral — hence `expected_from` starts equal to `proposed_from` and is the authoritative column
-- throughout. Q2(a): the latest valid in-scope managerial action supersedes regardless of role, so
-- the decision columns are last-writer-wins by design; accountability lives in `audit_logs`, which
-- is why there is no per-decision history table here.
--
-- Additive throughout. Rollback = drop the four decision columns, `proposed_from`, and the partial
-- unique index; the enum member added by the companion migration stays and is inert.

ALTER TABLE "vehicle_unavailability_reports"
  -- The SE's entry, immutable after creation. `expected_from` remains the authoritative date and is
  -- the only one any consumer should read; `proposed_from` exists so a manager's override can never
  -- silently rewrite what the field actually reported.
  ADD COLUMN "proposed_from"   TIMESTAMPTZ(6),
  ADD COLUMN "decided_by"      UUID,
  ADD COLUMN "decided_by_role" TEXT,
  ADD COLUMN "decided_at"      TIMESTAMPTZ(6),
  -- APPROVED = the authoritative date is the SE's proposal; OVERRIDDEN = a manager replaced it.
  -- TEXT with a CHECK rather than an enum: same closed-vocabulary-in-one-place posture as #241's
  -- `removal_reason`, and it keeps this migration free of the add-value-then-use restriction.
  ADD COLUMN "decision"        TEXT,
  ADD COLUMN "override_reason" TEXT;

-- Every pre-existing report was filed by an SE and never decided, so its current `expected_from` IS
-- the proposal (any manager edit predating this slice is unrecoverable and, measured 2026-08-19,
-- there are none: 0 rows in the dev mirror). Idempotent — a re-run touches nothing.
UPDATE "vehicle_unavailability_reports"
   SET "proposed_from" = "expected_from"
 WHERE "proposed_from" IS NULL;

ALTER TABLE "vehicle_unavailability_reports"
  ALTER COLUMN "proposed_from" SET NOT NULL;

ALTER TABLE "vehicle_unavailability_reports"
  -- A decision is one indivisible fact: who / when / what. Half of one is a bug, not a state.
  ADD CONSTRAINT "vehicle_unavailability_reports_decision_complete_chk"
    CHECK (("decision" IS NULL) = ("decided_at" IS NULL)
       AND ("decision" IS NULL) = ("decided_by_role" IS NULL)),
  ADD CONSTRAINT "vehicle_unavailability_reports_decision_vocab_chk"
    CHECK ("decision" IS NULL OR "decision" IN ('APPROVED', 'OVERRIDDEN')),
  -- Overriding an SE's field report without saying why is exactly the action that needs a reason.
  ADD CONSTRAINT "vehicle_unavailability_reports_override_reason_chk"
    CHECK ("decision" IS DISTINCT FROM 'OVERRIDDEN'
        OR ("override_reason" IS NOT NULL AND btrim("override_reason") <> ''));

-- Retire duplicate OPEN reports before the invariant that forbids them. Newest wins: it is the most
-- recent account of the vehicle, and it is the row `SchedulerPreviewService.placeHold` and the ZM
-- queue already pick (`orderBy createdAt desc`), so this normalises the data to the behaviour that
-- was already in effect. 0 rows in the dev mirror (measured 2026-08-19); written to be correct
-- anywhere rather than to be a no-op here.
UPDATE "vehicle_unavailability_reports" r
   SET "status" = 'SUPERSEDED'
 WHERE r."status" = 'OPEN'
   AND EXISTS (
         SELECT 1 FROM "vehicle_unavailability_reports" newer
          WHERE newer."ticket_id" = r."ticket_id"
            AND newer."status" = 'OPEN'
            AND (newer."created_at", newer."id") > (r."created_at", r."id")
       );

-- The invariant. Partial, so superseded and resolved history stays unconstrained — a ticket
-- accumulates as many closed reports as it has absences, and exactly one live one.
CREATE UNIQUE INDEX "vehicle_unavailability_reports_one_open_per_ticket"
  ON "vehicle_unavailability_reports" ("ticket_id")
  WHERE "status" = 'OPEN';
