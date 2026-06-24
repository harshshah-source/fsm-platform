-- Issue 27, slice 1 — role backup cascade (CONTEXT.md §15). Records that a manager-tier role (a
-- specific ZM's zone, or a cross-zone role) is unavailable for a window, so the strict upward cascade
-- (ZONAL_MANAGER → CENTRAL_SERVICE_MANAGER → OPERATIONS_HEAD) can resolve who currently holds the duty.

CREATE TABLE "role_unavailability" (
    "id" BIGSERIAL NOT NULL,
    "role" "role" NOT NULL,
    "zone_id" BIGINT,
    "user_id" UUID,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "window_end" TIMESTAMPTZ(6),
    "reason" TEXT,
    "created_by" UUID,
    "created_by_role" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "role_unavailability_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "role_unavailability" ADD CONSTRAINT "role_unavailability_window_order"
    CHECK ("window_end" IS NULL OR "window_end" >= "window_start");
CREATE INDEX "role_unavailability_role_zone_start_idx"
    ON "role_unavailability"("role", "zone_id", "window_start" DESC);
