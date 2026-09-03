# 328 — One FLOATING re-validation definition
Status: ready-for-agent
Type: AFK
Wave: 4 · Severity: P3 · Finding: AR-9b, `audit/2026-09-01-scheduler-engine-forensics.md` §7

## Problem
The correctness-critical FLOATING live re-validation SQL (MV row re-checked against
`engineer_master.coverage_type='FLOATING' AND is_active`) is hand-mirrored in two files:
`recommender/candidate-selection.service.ts:41-49` and `scheduling/coverage-at-assign.ts:36-45`.
The copies agree today (documented); drift would let the engine and the at-assign stamp disagree
about who is a valid floating candidate.

## Root cause
The share was documented instead of implemented.

## Affected files / symbols
The two files above; one new shared function/fragment (recommender module exports it — the
dependency direction `scheduling → recommender` already exists).

## Intended behavior after fix
One definition, two importers, a drift-pinning test; behavior byte-identical (snapshot both
call sites' results on a fixture before folding).

## Implementation boundaries
Pure dedup; no logic change; no MV or schema change.

## DB / API / frontend impact
None.

## Dependencies
None (avoid landing concurrently with #304, which touches the recommender's capacity seam).

## Regression risks
Raw-SQL extraction must preserve parameter binding exactly — both call sites' existing specs pin
behavior.

## Tests required
Equivalence fixture (pre/post identical); drift pin (single definition asserted).

## Acceptance criteria
- [ ] AC1 — one definition, imported at both sites, pinned against re-spelling.

## UI surfaces
n/a.

## Reference
n/a.

## Blocked by
— (independent)
