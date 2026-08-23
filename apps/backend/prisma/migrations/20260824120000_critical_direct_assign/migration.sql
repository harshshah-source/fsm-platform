-- #268 — CRITICAL direct assignment retires SE Acceptance from the critical path (#258 Q3).
--
-- The status vocabulary gains exactly one value, per the pre-implementation review's correction:
-- `ASSIGNED_DIRECT` for a ticket the system assigned with no offer step. `ESCALATION_REQUIRED` is
-- kept spelled exactly as before — `system-efficiency-aggregation.service.ts` counts rows in that
-- state into the daily `auto_escalations` cube, and a renamed status would silently zero a live
-- report. Its MEANING narrows (from "3 SEs declined or timed out" to "no capacity-eligible SE
-- exists"); that is recorded in code comments and the completion report, not in a new column.
--
-- `PENDING_ACCEPTANCE` / `ACCEPTED` / `DECLINED` / `TIMED_OUT` are deliberately NOT removed from the
-- enum. Dropping a Postgres enum value is a type-recreation, not an additive change, and the issue's
-- own rollback note ("the insertion ledger rows remain readable under both vocabularies") means any
-- row a prior build wrote under the retired offer machinery must stay legible. This migration adds;
-- it does not take away.
ALTER TYPE "intraday_insertion_status" ADD VALUE 'ASSIGNED_DIRECT';

-- A correction to the issue's own Data Model section, found while implementing it: Q-B's escalation
-- ("every eligible candidate is at capacity", or none exist at all) can now fire on a ticket that was
-- NEVER offered to anyone — there is no SE to name and no acceptance window to bound. The two columns
-- below were NOT NULL under the old model because an offer always preceded every row; direct
-- assignment breaks that invariant for the escalation half specifically (the ASSIGNED_DIRECT half
-- always has a real SE and a real instant, so it never needs the NULL). Both become nullable rather
-- than backed by a sentinel value, which would be a fabricated fact in an audit-adjacent table.
ALTER TABLE "intraday_insertions" ALTER COLUMN "offered_se_id" DROP NOT NULL;
ALTER TABLE "intraday_insertions" ALTER COLUMN "acceptance_deadline" DROP NOT NULL;
