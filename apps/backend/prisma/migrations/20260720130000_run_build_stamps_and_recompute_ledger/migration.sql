-- #130 Slice 2 — run attribution (L3) + recompute ledger (L5). Pure additive offline DDL.
-- L3: every pipeline run records which build produced it, so a stale run can be flagged after the
-- fact (build_version < runtime_lock.version). Nullable — historical rows stay NULL, never blocked.
ALTER TABLE "master_sync_runs" ADD COLUMN "build_version" BIGINT, ADD COLUMN "build_fingerprint" TEXT;
ALTER TABLE "snapshot_runs"    ADD COLUMN "build_version" BIGINT, ADD COLUMN "build_fingerprint" TEXT;
ALTER TABLE "dispatch_runs"    ADD COLUMN "build_version" BIGINT, ADD COLUMN "build_fingerprint" TEXT;

-- L5: the recompute ledger — one row per DeviceStateService.recompute (counts + build + trigger).
-- Simultaneously the semantic-canary baseline and the missing attribution for the incident's write class.
CREATE TABLE "device_state_recomputes" (
  "recompute_id"      BIGSERIAL   PRIMARY KEY,
  "computed_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "eligible_count"    INTEGER     NOT NULL,
  "inactive_count"    INTEGER     NOT NULL,
  "departed_count"    INTEGER     NOT NULL,
  "total_count"       INTEGER     NOT NULL,
  "build_version"     BIGINT,
  "build_fingerprint" TEXT,
  "trigger"           TEXT        NOT NULL,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "device_state_recomputes_computed_at_idx" ON "device_state_recomputes" ("computed_at" DESC);
