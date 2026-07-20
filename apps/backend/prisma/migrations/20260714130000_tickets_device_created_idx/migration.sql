-- Device Detail page loaded in ~80-90s at fleet scale (20k devices / 19k tickets): the device-list
-- query's latest-live-ticket LATERAL (`WHERE t.device_id = ds.device_id ORDER BY t.created_at DESC
-- LIMIT 1`) had no tickets(device_id) index, so it seq-scanned tickets once per device — and the
-- COUNT(*) OVER() total forces the lateral across the whole filtered set, not just the page.
-- Composite (device_id, created_at DESC) serves both the FK lookup (issue #103, HIGH #12 of the
-- 2026-07-03 production-readiness audit) and the lateral's ORDER BY. Measured: 86s -> 0.8s.

CREATE INDEX "tickets_device_id_created_at_idx" ON "tickets" ("device_id", "created_at" DESC);
