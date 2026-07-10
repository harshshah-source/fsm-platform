# ADR-0017: Canonical Candidate Processing Order — Company Tier → Device Bucket → Company Priority Rank → Oldest Inactive → Device ID

## Status

Accepted

## Context

The Recommender's Plant Cluster Multiplier (ADR-0003) gives a score boost to additional Devices at a Plant already in an SE's Day Plan. For this boost to behave reproducibly and for Day Plans to be deterministic (same input → same output), the order in which candidate `(SE, Device)` pairs are processed must be strictly defined.

A Plant-ID-first order would group clusters early but violate the Customer-Tier-then-Device-Bucket precedence from ADR-0003. A hash-based random-with-seed order makes the cluster effect operationally unexplainable. Folding Device Bucket into the weighted score only (removing it as a sort key) would let Platinum WARNINGs starve Platinum CRITICALs — the problem ADR-0003 specifically prevents.

## Decision

The Recommender processes candidate `(SE, Device)` pairs in a strict, deterministic order:

1. **Company Tier** descending (`PLATINUM > GOLD > SILVER`).
2. **Device Bucket** descending within the same Company Tier (`LONG_PENDING > VERY_SEVERE > SEVERE > HIGH_CRITICAL > CRITICAL > RISK > EARLY_RISK > WARNING`).
3. **Company Priority Rank** ascending (`A` before `B` before `C` …).
4. **Oldest Inactive** ascending (smaller `latest_gps_datetime` = older = processed first).
5. **Device ID** ascending — final absolute tie-breaker.

The first candidate processed at any given Plant is the *seed* of that Plant's cluster (no cluster boost). Subsequent same-Plant candidates picked up later receive the Plant Cluster Multiplier, making them more likely to land in the same SE's Day Plan.

## Consequences

- The order is enforced as a stable SQL `ORDER BY` over the candidate set.
- Tests pin the order with a fixture-based assertion so future refactors cannot silently break it.
- `RECOMMENDATION_HISTORY` carries the processing rank of each suggestion so audit can answer "what position in the queue was this Ticket?"
- Reports show the breakdown of skipped-by-gate Tickets at each tier level so managers see where the queue is shaped by gates vs by score.
