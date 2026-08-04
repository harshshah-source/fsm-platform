-- #213 -- the optional "why" on a manually-triggered dispatch run. Nullable and additive: every
-- existing row (and every CRON run) legitimately has none, and the manual trigger's existing callers
-- keep working unchanged. Operator rationale: an emergency run with a one-line reason is worth a lot
-- when someone reads the audit trail three weeks later.
ALTER TABLE "dispatch_runs" ADD COLUMN "reason" TEXT;
