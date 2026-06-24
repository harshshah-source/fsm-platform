# 35 — Non-Operational dual-confirmation marking

Status: ready-for-agent
Type: AFK

## What to build

The Non-Operational marking lifecycle (`/non-op`). Dual-confirmation queue sorted by `awaiting_since` asc; row states `AWAITING_MANAGER_CONFIRMATION` / `AWAITING_CUSTOMER_CONFIRMATION` (days-elapsed badge) / `CONFIRMED`. The Confirm modal captures reason code, effective window, deal type, and the active Tickets that will auto-close; for a RECURRING device it warns "A Recovery Ticket will be auto-created." with an explicit checkbox. On `CONFIRMED`: new Failure Cycles are blocked for the device, in-flight Tickets auto-close, the device leaves the Fleet Uptime eligible set, and (RECURRING deals only) a Recovery Ticket is auto-created and queued to the Recommender (toast confirms the Recovery Ticket number). Operations Head can **override-confirm** after 7 days of no response from the other party, with a mandatory free-text audit reason. Customer confirmation is via a one-time tokenised email link in v1 (no portal).

## Acceptance criteria

- [ ] Dual-confirmation queue with correct row states and days-elapsed badges
- [ ] CONFIRMED reachable only after both parties confirm (or OH 7-day override-confirm with reason)
- [ ] CONFIRMED blocks new Failure Cycles and auto-closes in-flight Tickets
- [ ] RECURRING device on CONFIRMED auto-creates a Recovery Ticket and queues it (toast with number)
- [ ] Confirmed device excluded from Fleet Uptime eligible set
- [ ] Customer confirmation via one-time tokenised email link

## Blocked by

- #07
- #49 (`device.deal_type` column — drives the RECURRING-only auto-Recovery-Ticket rule)
