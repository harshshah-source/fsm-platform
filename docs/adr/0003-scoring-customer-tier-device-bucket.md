# ADR-0003: Scoring Uses Customer-Tier-First, Device-Bucket-Second Tier Structure

## Status

Accepted

## Context

The Recommender must rank candidate `(SE, Device)` pairs. Two extremes were considered: pure Device-Bucket-first (inactivity age dominates) and pure Customer-Tier-first (premium contracts dominate). Both extremes fail: pure bucket-first ignores that a Platinum company's expectation is fundamentally different from a Silver's; pure tier-first would let a Platinum WARNING device starve a Platinum CRITICAL device.

## Decision

Candidate `(SE, Device)` pairs are ranked in four layers:

1. **Hard Filters** — drop ineligible candidates before scoring. Current set: vehicle readiness `ON_TRIP`; required component unavailable (see ADR-0012); SE over Daily Capacity; SE not `AVAILABLE`; SE missing Common Kit. (`STALE`/`UNKNOWN` readiness is a ZM conflict signal, not a drop. **SE activity-ping staleness is NOT a Hard Filter** — `last_activity_at` is visibility/audit only and never gates scoring; CONTEXT §3/§16, revised 2026-06-09.)

2. **Company Tier (top-level gate)** — every Ticket for a `PLATINUM` customer is processed before any `GOLD` customer's Ticket, which precedes any `SILVER` customer's. Tier is `PLATINUM | GOLD | SILVER` from `COMPANY_MASTER.company_tier`.

3. **Device Bucket (secondary tier within each Company Tier)** — within Platinum, `CRITICAL+` Tickets come before lower buckets; same within Gold; same within Silver.

4. **Weighted score within each (Company Tier × Device Bucket) cell** — combines `company_priority_rank` (A/B/C…), vehicle dispatch urgency, repeat-failure penalty, and (for Floating SEs) distance-from-previous-stop.

**Plant Cluster Multiplier** is applied on top: once an SE has Plant P in their plan, every additional Plant P Ticket receives a cluster boost (see ADR-0017 for canonical processing order).

## Consequences

- The Recommender persists a per-candidate score breakdown (Company Tier, Device Bucket, weighted components, applied multipliers) so the manager UI can show "why was this suggested?"
- The Company Tier gate can starve Silver-customer work behind Platinum/Gold backlogs — visible on the manager dashboard as "X Silver-tier Tickets skipped today by Company Tier gate." This triggers Operations Head review when starve depth crosses a threshold.
- Weights inside each cell are configurable by Admin via Settings; each Morning Batch captures the active weight set in audit.
- Candidates must be processed in canonical order from ADR-0017 for reproducible plans.
