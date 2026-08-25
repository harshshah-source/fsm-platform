-- #287 — the run can tell whether its eligibility data is fresh.
--
-- `plant_eligible_floating_se` is refreshed at 04:30 IST and consumed by the 05:00 dispatch run. The
-- refresh tick swallows its own failure (logs, returns {ran:false, reason:'ERROR'}, escalates
-- nothing) and the run performs no freshness check — its only readers are refresh() and
-- eligibleSeIdsForPlant(). A failed refresh therefore produces a silently wrong FLOATING candidate
-- pool with no signal anywhere, and config_snapshot does not record MV state either, so the run's
-- own frozen record cannot answer "what was this decided against".
--
-- One row per view, upserted by the refresher. Deliberately NOT a log table: the question is "is the
-- data I am about to use fresh", which is a current-state question with exactly one answer per view.
-- Failure history belongs in logs and the run ledger, not here.

CREATE TABLE "mv_refresh_state" (
  "view_name"        TEXT PRIMARY KEY,
  "last_attempt_at"  TIMESTAMPTZ(6) NOT NULL,
  "last_success_at"  TIMESTAMPTZ(6),
  "last_error"       TEXT,
  "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE "mv_refresh_state" IS
  'Freshness of each materialized view its consumers depend on (#287). One row per view.';
COMMENT ON COLUMN "mv_refresh_state"."last_success_at" IS
  'When the view last actually rebuilt. NULL means it has never succeeded — not that it is fresh.';
COMMENT ON COLUMN "mv_refresh_state"."last_error" IS
  'The most recent failure message, cleared on the next success. Diagnosis only, never a predicate.';
