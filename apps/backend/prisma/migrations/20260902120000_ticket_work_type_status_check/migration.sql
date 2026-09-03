-- #309 (CB-12) — the `work_type ⇔ status` CHECK `schema.prisma` has documented since Issue 05 but
-- that no migration ever created. Raw SQL, the same pattern as the sibling invariants in
-- 20260620124718 (`tickets_troubleshoot_requires_cycle`, `failure_cycles_pause_coupling`): Prisma
-- cannot express a CHECK, so it lives here and is pinned from
-- `test/work-type-status-invariant.e2e-spec.ts`, which sweeps every (work_type, status) pair the
-- live enums allow — both that each legal one inserts and that each illegal one is refused.
--
-- The map is derived from the writers, not the PRD (#309's recorded probe result carries the
-- per-status justification and the read-only probe that found 0 violating rows in 30,460 dev
-- tickets before this landed):
--
--   TROUBLESHOOT   ticket-creation → submission → verification / auto-recovery / repeat-escalation
--   INSTALL        install create → schedule → on-site → fitment → activation verification
--   RECOVERY       non-operational create → schedule → on-site → collection → warehouse receipt
--
-- Three rulings this SQL encodes:
--   * `SUBMITTED`, `FITTED` and `RECEIVED_AT_WAREHOUSE` are written to `ticket_events` but never
--     persisted on the row today. They stay legal on their own ladder — this constraint couples a
--     status to a WORK TYPE, it is not a transition-order rule.
--   * `CLOSED` and `CLOSED_NON_OPERATIONAL` are legal on all three. Device departure and plant
--     deactivation close work-type-blind, and a non-operational device leaving service is the same
--     family of closure.
--   * `ESCALATED` and `CLOSED_AUTO_RECOVERY` stay TROUBLESHOOT-only: both hang off the failure-cycle
--     machinery, which no other work type has.

ALTER TABLE "tickets"
  ADD CONSTRAINT "tickets_work_type_status"
  CHECK (
    ("work_type" = 'TROUBLESHOOT' AND "status" IN (
       'OPEN', 'SUBMITTED', 'VERIFICATION_PENDING', 'ESCALATED', 'FAILED_VERIFICATION',
       'CLOSED_AUTO_RECOVERY', 'CLOSED', 'CLOSED_NON_OPERATIONAL'))
    OR
    ("work_type" = 'INSTALL' AND "status" IN (
       'REQUESTED', 'SCHEDULED', 'ON_SITE', 'FITTED', 'ACTIVATED', 'FAILED_ACTIVATION',
       'CLOSED', 'CLOSED_NON_OPERATIONAL'))
    OR
    ("work_type" = 'RECOVERY' AND "status" IN (
       'REQUESTED', 'SCHEDULED', 'ON_SITE', 'COLLECTED', 'RECEIVED_AT_WAREHOUSE', 'FAILED_RECOVERY',
       'CLOSED', 'CLOSED_NON_OPERATIONAL'))
  );
