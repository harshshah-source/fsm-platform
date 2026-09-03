# 330 — Per-plant candidate memoisation in the recommender
Status: done (2026-09-03) - see `docs/progress/330-candidate-query-memoisation.md`
Type: AFK
Wave: 4 · Severity: P3 · Finding: AR-11, `audit/2026-09-01-scheduler-engine-forensics.md` §7

## Problem
`orderedCandidatesForPlant` runs once **per ticket** (`recommender.service.ts:593`) with no
memoisation across tickets at the same plant (kit/availability *are* memoised) — ~2,000+ round
trips inside one zone's window for a 900-ticket zone. Beyond cost, the long window is the
exposure RC-5 (#305) bounds: this shrinks it.

## Root cause
Per-ticket call shape predates the large-zone reality; `candidate-query.service.ts:65-73`
documents the same scaling caveat for Distribute.

## Affected files / symbols
`apps/backend/src/recommender/recommender.service.ts` (per-run memo keyed by plant),
`recommender/candidate-selection.service.ts` (read-only).

## Intended behavior after fix
Candidate *pools* are fetched once per (run, plant) and reused across that plant's tickets;
per-ticket readiness/filters/scoring are unchanged (capacity and cluster state legitimately
change per ticket — only the pool query is memoised). Decision output byte-identical.

## Implementation boundaries
Run-scoped memo only — never cross-run, never cross-zone; no ordering change; dry-run paths
(preview/Distribute) inherit it via the same code, not a fork.

## DB / API / frontend impact
None (query volume only).

## Dependencies
Not concurrent with #304 (same service). After it.

## Regression risks
A pool cached before a mid-run coverage change would be stale — within one run that is already
the semantics (the run reads a snapshot); state it in a comment. Equivalence is the test.

## Tests required
Equivalence: a multi-ticket-per-plant fixture produces identical recommendations/traces pre/post
(dry-run parity spec pattern); query-count assertion (pool queried once per plant).

## Acceptance criteria
- [x] AC1 — pool queries scale with plants, not tickets; decisions byte-identical.

## UI surfaces
n/a.

## Reference
n/a.

## Blocked by
304 (same service — sequence)
