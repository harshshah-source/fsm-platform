-- #357 — give a verification run somewhere to record WHY its ticket is escalated.
--
-- `VerificationService.escalateFraud` demands a mandatory reason and then writes it only into
-- `audit_logs.metadata`. That row is readable in Ops Explorer (§1 correction V-05) and nowhere else:
-- `/reports/verification-outcomes` aggregates `verification_runs` and the ZM review queue reads the
-- run row, so the single field a reviewer opens the queue to see is the one field neither surface can
-- reach without joining an append-only audit table by entity id.
--
-- Semantics are deliberately "live verdict", not "history": `escalate` sets it, `deescalate` (new in
-- this slice) clears it. NULL therefore means "this run's ticket is not under escalation" and never
-- "escalated for an unrecorded reason" — which is exactly what a report can filter on. The full
-- history of both transitions stays in `audit_logs` + `ticket_events`, where history belongs.
--
-- Nullable with no default, so every existing row is untouched and honest: runs written before this
-- column existed were escalated (if at all) with their reason in the audit log only, and NULL is the
-- truthful reading of that.

ALTER TABLE "verification_runs" ADD COLUMN "escalation_reason" TEXT;
