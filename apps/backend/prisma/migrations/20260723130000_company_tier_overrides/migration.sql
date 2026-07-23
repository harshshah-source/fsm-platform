-- Issue 157, Slice 2 — company_tier_overrides (scoped, expiring tier override; CSM/ZM authority
-- extension over the OH-owned global company_master.company_tier). Stacking ALLOWED (Q-A,
-- confirmed 2026-07-23 at S2 go-ahead): multiple ACTIVE rows may coexist per (company_id, zone_id);
-- the effective-tier resolver (effective-tier.ts) picks the newest by (created_at DESC, id DESC).
-- No partial-unique — the lookup index below serves the resolver read. The expiry-window CHECK is
-- raw SQL (not Prisma-expressible), same posture as se_coverage / soft_states.

CREATE TYPE "company_tier_override_status" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');

CREATE TABLE "company_tier_overrides" (
  "id"           BIGSERIAL                     NOT NULL,
  "company_id"   BIGINT                        NOT NULL,
  "zone_id"      BIGINT                        NOT NULL,
  "tier"         "company_tier"                NOT NULL,
  "reason"       TEXT                          NOT NULL,
  "expires_at"   TIMESTAMPTZ(6)                NOT NULL,
  "status"       "company_tier_override_status" NOT NULL DEFAULT 'ACTIVE',
  "created_by"   UUID,
  "created_at"   TIMESTAMPTZ(6)                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ(6)                NOT NULL,
  "cancelled_by" UUID,
  "cancelled_at" TIMESTAMPTZ(6),
  CONSTRAINT "company_tier_overrides_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "company_tier_overrides_expiry_window_chk"
    CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + INTERVAL '2 months')
);

-- Serves the effective-tier resolver's newest-ACTIVE-unexpired read for a (company, zone) pair.
CREATE INDEX "company_tier_overrides_lookup_idx"
  ON "company_tier_overrides" ("company_id", "zone_id", "status", "expires_at");

ALTER TABLE "company_tier_overrides"
  ADD CONSTRAINT "company_tier_overrides_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "company_master"("company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "company_tier_overrides"
  ADD CONSTRAINT "company_tier_overrides_zone_id_fkey"
  FOREIGN KEY ("zone_id") REFERENCES "zones"("zone_id") ON DELETE RESTRICT ON UPDATE CASCADE;
