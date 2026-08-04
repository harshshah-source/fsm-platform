-- Issue 171 (D-3/D-3b settled 2026-07-28) -- transporter contact data, Shape A. FSM-owned master
-- column (workflow:1639's "Owner: Operations Head / integration"), no ingestion source, resolved
-- server-side into a single field the client never learns the provenance of -- a later per-plant
-- override table would slot in without touching the frozen contract (#170 compatibility bar).
-- Nullable, empty on day one; the "no contact on file" state is a real, honest client state, not an
-- error -- population is a separate rollout/admin task (see the issue's own Population section).
ALTER TABLE "transporters" ADD COLUMN "contact_phone" TEXT;

-- Per-report capture (workflow:283, workflow:1650; PRD:552 "transporter name/number used") -- what
-- the SE actually dialed, as field evidence and a reconciliation signal for the master above. Both
-- nullable: the SE may not have used any transporter contact (e.g. reasonCode OTHER).
ALTER TABLE "vehicle_unavailability_reports" ADD COLUMN "transporter_name" TEXT;
ALTER TABLE "vehicle_unavailability_reports" ADD COLUMN "transporter_contact" TEXT;
