-- Issue 101 — one live intra-day offer per ticket (guarded-transition backstop).
-- The `fireForZone` sweep already avoids duplicates with a query-time `none` check, but two concurrent
-- sweeps (or a manual + scheduled tick) could each open a PENDING_ACCEPTANCE offer for the same ticket,
-- so two SEs are simultaneously told the same CRITICAL ticket is theirs. This partial unique is the
-- durable, cross-connection backstop: at most one LIVE (PENDING_ACCEPTANCE) offer per ticket. The reroute
-- path updates the same row (keeps the single offer), and an ACCEPTED insertion is not constrained here,
-- so retry/escalation lifecycles are unaffected — only a duplicate live offer collides (→ P2002, a clean
-- skip in `fireForZone`).
CREATE UNIQUE INDEX "intraday_insertions_one_live_offer_per_ticket"
  ON "intraday_insertions" ("ticket_id") WHERE "status" = 'PENDING_ACCEPTANCE';
