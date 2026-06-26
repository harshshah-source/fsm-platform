-- Issue 34 — Install lifecycle + verification + serial visibility. Additive on `tickets`: the SE
-- fitment capture recorded at the FITTED stage (the GPS device serial + SIM serial the Warehouse
-- Manager verifies, plus an optional install photo) and the two lifecycle anchors `fitted_at` and
-- `activated_at`. `activated_at` is the warranty start (CONTEXT.md §4) and the anchor the install
-- auto-verification watches the new device_id's first valid post-fitment ping from. No new enum: the
-- lifecycle states (SCHEDULED/ON_SITE/FITTED/ACTIVATED/FAILED_ACTIVATION) were defined up-front in the
-- ticket_status enum. TROUBLESHOOT/RECOVERY rows leave these null.

ALTER TABLE "tickets"
  ADD COLUMN "fitted_gps_serial" TEXT,
  ADD COLUMN "fitted_sim_serial" TEXT,
  ADD COLUMN "fitted_photo_ref" TEXT,
  ADD COLUMN "fitted_at" TIMESTAMPTZ(6),
  ADD COLUMN "activated_at" TIMESTAMPTZ(6);

-- The install auto-verification sweep scans ACTIVATED install tickets by activation time.
CREATE INDEX "tickets_activated_at_idx" ON "tickets"("activated_at");
