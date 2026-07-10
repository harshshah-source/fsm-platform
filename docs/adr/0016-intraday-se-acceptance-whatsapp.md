# ADR-0016: Intra-day CRITICAL Insertions Require SE Acceptance + WhatsApp Confirmation; Offline SEs Auto-Reroute on Acceptance Timeout

## Status

Accepted — **partially superseded by CONTEXT.md Decisions §3 & §16 (revised 2026-06-09)**: the
"15-min intra-day `last_activity_at` Hard Filter" described below is **removed**. Activity pings are
visibility/audit only and never gate candidate scoring; intra-day unreachability is handled solely by
the Acceptance Timeout + reroute (still valid below). The SE-Acceptance / WhatsApp / timeout-reroute
/ 3-retry-escalation decisions remain in force.

## Context

When an Intra-day Re-plan (ADR-0002) selects an SE for a new CRITICAL insertion, the SE is already mid-route. Making the manager the commit authority for something the SE hasn't agreed to produces wasted dispatches to an SE who may be hours away. Holding the Ticket until an online SE is found risks an indefinite stall for a CRITICAL device. Proposing to backup SEs concurrently creates duplicate-claim race conditions that fight the strict-precedence model (ADR-0001).

## Decision

For intra-day CRITICAL insertions, the system sends an **in-app notification** asking the SE to **accept**. The assignment is **not committed** until the SE taps Accept in the mobile app.

On acceptance, a **WhatsApp Confirmation** message is sent to the SE with ticket detail, vehicle, plant, expected component (if any), and a deeplink back into the mobile app — redundant context for when the SE later opens WhatsApp instead of the app.

**Acceptance Timeout** (default 10 min): if the SE does not respond, the system auto-reroutes to the next-best SE per strict-precedence (ADR-0001) and repeats. After **3 unsuccessful retries**, the insertion escalates to the acting Zonal Manager for explicit assignment.

**SE Decline** is a first-class action distinct from timeout. An SE who declines must record a reason code: `AT_CAPACITY | TRAVEL_TOO_FAR | VEHICLE_TROUBLE | OTHER`.

**Offline-SE handling** (revised 2026-06-09 — supersedes the original 15-min Hard Filter):
- **No pre-emptive activity-ping filter.** An SE is never excluded from intra-day candidate scoring on the basis of a stale `last_activity_at` — pings are visibility/audit only (CONTEXT §3, §16). An unreachable SE simply doesn't tap Accept, so the **Acceptance Timeout auto-reroutes** to the next-best SE. The timeout *is* the unreachability handler.
- An SE who regains network after re-routing sees: *"Ticket-XXXXX was offered to you at HH:MM and routed to [SE name] at HH:MM because you didn't respond in time. No action needed."*

## Consequences

- `ENGINEER_MASTER.last_activity_at` updated on any SE-initiated app action (not a fixed-interval timer — see ADR-0024). It drives **only** the 1h `OFFLINE` Activity Status display label; it is **not** a Recommender Hard Filter and never removes an SE from candidate scoring (the prior 15-min freshness filter is removed — CONTEXT §3, §16).
- `RECOMMENDATION_HISTORY` for intra-day insertions carries the full retry chain: `[ {se: A, offered_at, timed_out}, {se: B, offered_at, accepted_at} ]`.
- **WhatsApp integration** is a v1 dependency (was previously optional/fallback).
- The Manager Revert Window concept from the prior ADR-0007 shape is **removed** — manager override of an accepted assignment happens through the normal override UI before SE departs for the Plant.
- Decline reason codes surface in reports — patterns trigger review for coordination failure or SE wellbeing issues.
