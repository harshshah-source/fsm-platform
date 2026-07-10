# ADR-0001: SE-to-Device Routing Uses Strict Precedence with Capacity Fallback

## Status

Accepted

## Context

When a Device goes inactive, the Recommender must decide which Service Engineer (SE) to suggest. With ~50,000 devices pan-India and ~40 SEs of three coverage types (Dedicated, Multi-Plant, Floating), two routing models were considered: strict precedence and open pool.

An open-pool model (every eligible SE is a candidate each cycle) produces locally-optimal routing per device but destroys the plant-relationship and plan-stability benefits that come from predictable assignment. Plant clustering — the largest efficiency lever — fights against itself in an open pool.

## Decision

When a Device goes inactive, the Recommender offers it to SEs in strict precedence order:

1. **Dedicated SE** for that Plant — first preference always.
2. **Multi-Plant SE** covering that Plant — engaged if Dedicated SE is `ON_LEAVE`, `OFF_SHIFT`, at Daily Capacity, or otherwise unavailable.
3. **Floating SE** whose Territory includes the Plant — fallback when no plant-mapped SE is available.

A Floating SE is engaged *early* only when the primary is unavailable per `SE_AVAILABILITY` or the Plant has no plant-mapped SE at all. The Zonal Manager can override the precedence per Ticket at approval time.

## Consequences

- The Recommender must know each SE's coverage type (`DEDICATED | MULTI_PLANT | FLOATING`).
- A new `ENGINEER_TERRITORY_COVERAGE` construct is required for Floating SEs (see ADR-0006).
- "Primary SE unavailable" is defined precisely via the `SE_AVAILABILITY` model (see ADR-0010).
- Dedicated SEs build plant relationships that speed diagnosis; Floating SE travel time is expensive and reserved for real gaps.
- SEs get a stable plan they can rely on — open-pool churn is avoided.
