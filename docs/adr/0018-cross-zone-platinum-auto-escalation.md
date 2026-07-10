# ADR-0018: Cross-Zone Help Is Auto-Asked Only for Platinum Customers; Gold/Silver Require Manual Zonal Manager Escalation

## Status

Accepted

## Context

When a Ticket cannot be assigned within its home Zone (Recommender has exhausted eligible local SEs through retries and Hard Filters per ADR-0001, ADR-0003, ADR-0016), the system must decide what happens next. Moving an EAST Floating SE into SOUTH zone has real cost (travel time, mileage, fatigue) — a cost that is only worth paying automatically for the highest-value customers. But a Platinum CRITICAL sitting unassigned for 24 hours is a contract-level service failure the system should not allow to happen quietly.

## Decision

When a Ticket cannot be locally assigned, the response depends on `company_tier`:

**Platinum company** — system **auto-pings the Central Service Manager** with: *"This Platinum Ticket cannot be covered locally in [Zone] — please authorise cross-zone capacity."* Auto-trigger fires when the Ticket has been unassigned for:
- **1 hour** in `CRITICAL` bucket, *or*
- **4 hours** without reaching `SUBMITTED` since opening.

Central Service Manager approves or denies in their cross-zone dashboard.

**Gold and Silver companies** — Ticket sits in a **"Couldn't Assign" queue** on the home Zonal Manager's dashboard. The manager decides whether to escalate to Central Service Manager (one-click), wait for local capacity, or defer. **No auto-trigger.**

The Zonal Manager can manually flag any Ticket (any tier) for cross-zone escalation at any time before the auto-trigger fires — the auto-trigger is a safety net for Platinum, not a replacement for manager judgment.

A Platinum auto-escalation denied by Central Service Manager falls back into the home Zonal Manager's queue with a denial reason — the manager can manually re-escalate to Operations Head if they disagree.

## Consequences

- A new `CROSS_ZONE_ESCALATION` table records: trigger (auto vs manual), trigger reason (no local capacity / SLA-window risk / manual override), home Zone, target Zone, requesting role, approving role, decision (approved/denied/deferred), decision timestamp.
- Reports surface per-Zone "auto-escalations triggered this month" — a Zone hitting many auto-triggers is a capacity-planning signal for Operations Head.
- The "Couldn't Assign" queue on Zonal Manager dashboards aggregates Gold/Silver stuck Tickets for batch decision rather than one-by-one.
- "Manager forgot to escalate" is not an acceptable explanation for a failed Platinum SLA — the auto-trigger ensures it cannot happen silently.
