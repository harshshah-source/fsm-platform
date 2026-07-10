# Progress — Issue 10: Recommender scoring + Hard Filters + canonical sort

> Build date: 2026-06-21 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All 6 acceptance criteria green. Backend **205 tests / 62 files**, `tsc --noEmit`
> clean (PostgreSQL 16 + PostGIS on :5433).

## Scope & decisions

The Recommender's **candidate-selection engine** (LLD §13.1 steps 1–5). Day-Plan grouping +
auto-dispatch (`work_schedules` / `plant_batch_assignments`) is **Issue 11** — this issue selects,
scores, explains, and persists one `recommendations` row per ticket.

1. **Hard Filters are pluggable seams (HITL choice).** Built as pure predicates over a candidate
   readiness shape. The data behind ON_TRIP readiness (Issue 28), Common Kit / expected components
   (Issue 21), and SE availability (Issue 25/26) doesn't exist yet, so the orchestrator supplies those
   dimensions as defaults that *pass* — but the **drop logic is real and unit-tested** by injecting
   failing candidates. Daily Capacity is enforced for real (within-run counts vs `daily_capacity`),
   and `available` currently reads `engineer_master.is_active`. No foreign tables fabricated.
2. **Output = per-ticket recommendation rows (HITL choice).** AC#6 persistence is in this issue.
3. **`STALE`/`UNKNOWN` vehicle readiness is not a drop** (ZM conflict signal, per LLD §13.1).
4. **Floating distance-from-previous-stop deferred** — needs day-plan geo (Issue 11/14); the distance
   term is neutral (null) in scoring for now and documented in the breakdown.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Strict-precedence routing + documented fallback | 🟢 | `CandidateSelectionService.orderedCandidatesForPlant` (Dedicated→Multi→Floating via MV); capacity fallback in the orchestrator. `candidate-selection.e2e-spec.ts`, `recommender-run.e2e-spec.ts` (Dedicated→Multi at capacity). |
| 2 | Hard Filters drop before scoring | 🟢 | `applyHardFilters` (ON_TRIP / unavailable / over-capacity / kit / component; STALE not a drop). `hard-filters.spec.ts`. **Corrected 2026-06-22:** the intra-day 15-min `HEARTBEAT_STALE` drop was removed — activity-ping staleness is not a Hard Filter (CONTEXT §3/§16); see handoff `fsm-handoff-2026-06-22-heartbeat-filter-removal.md`. |
| 3 | Deterministic canonical sort vs mixed input | 🟢 | `canonicalSort` (Tier→Bucket→Rank→Oldest→DeviceID, ADR-0017), fixture-pinned. `canonical-sort.spec.ts`. |
| 4 | Weighted scoring reads configurable weights; cluster multiplier | 🟢 | `scoreCandidate` (weights from `priority_rule_config`); multiplier from `system_settings.plant_cluster_multiplier`, seed=1.0. `scoring.spec.ts`, `recommender-run.e2e-spec.ts`. |
| 5 | Structured reasoning payload | 🟢 | `recommendations.score_breakdown` jsonb (tier/bucket/rank/weights/components/clusterMultiplier/weightSetRef). `recommender-run.e2e-spec.ts`. |
| 6 | `recommendations` rows persisted | 🟢 | `recommendations` table + `RecommenderService.runForZone` (SUGGESTED / UNASSIGNABLE). `recommendations-schema.e2e-spec.ts`, `recommender-run.e2e-spec.ts`. |

## Slice-by-slice RED→GREEN report

Each slice was a vertical tracer bullet: one failing test (RED) → minimal implementation (GREEN).

- **Slice 1 — `recommendations` schema.**
  - RED: `recommendations-schema.e2e-spec.ts` (3 tests) — table/columns/FKs/indexes absent.
  - GREEN: `RecPath` enum + `Recommendation` model + migration `20260621170000_add_recommendations`; `migrate deploy` + `generate`. 3/3 green.
- **Slice 2 — canonical sort (ADR-0017).**
  - RED: `canonical-sort.spec.ts` (2 tests) — module missing; fixture pins `['C','E','F','B','A','D']`.
  - GREEN: `src/recommender/canonical-sort.ts` (`compareCandidates` / `canonicalSort`, non-mutating). 2/2 green.
- **Slice 3 — Hard Filters (ADR-0003 layer 1).**
  - RED: `hard-filters.spec.ts` (4 tests) — module missing; covers each drop reason, STALE-not-a-drop.
  - GREEN: `src/recommender/hard-filters.ts` (`applyHardFilters` over the readiness seam). 4/4 green.
  - **Correction (2026-06-22):** the original slice shipped an intra-day 15-min `HEARTBEAT_STALE`
    drop (from ADR-0016/0024). That contradicts CONTEXT §3/§16 (revised 2026-06-09): activity pings
    are visibility/audit only and never gate scoring. Removed under TDD — the staleness test was
    inverted to prove stale/no-ping SEs stay candidates; `intraday`/`activityStalenessMs`/
    `lastActivityAt` dropped from the filter seam.
- **Slice 4 — weighted scoring + Plant Cluster Multiplier (ADR-0003 layer 4).**
  - RED: `scoring.spec.ts` (5 tests) — module missing; rank/urgency/repeat/distance/multiplier/configurable-weights.
  - GREEN: `src/recommender/scoring.ts` (`scoreCandidate` → `{ score, breakdown }`). 5/5 green.
- **Slice 5 — strict-precedence ordering (ADR-0001).**
  - RED: `candidate-selection.e2e-spec.ts` (1 test) — service missing; expects Dedicated→Multi→Floating.
  - GREEN: `CandidateSelectionService.orderedCandidatesForPlant` (se_coverage + MV). Fixed a shared-DB state-overlap flake by isolating the fixture with a unique state. 1/1 green.
- **Slice 6 — orchestrator.**
  - RED: `recommender-run.e2e-spec.ts` (3 tests) — service missing; reasoning/persist, capacity fallback + cluster boost, UNASSIGNABLE.
  - GREEN: `RecommenderService.runForZone` (sort → precedence+hard-filter+capacity fallback → score → persist + reasoning). Seeded `plant_cluster_multiplier` default + within-cell weights; `RecommenderModule` wired into `AppModule`. 3/3 green.

Test counts added by this issue: **+18 tests / +6 files** (backend went 187→205 / 56→62).

## Deviations / deferred (read before extending)

1. **Hard-filter data sources are seams** — vehicle readiness (28), van stock / components (21), SE
   availability (25/26) default to "pass"; wire real reads when those issues land. The predicate logic
   is final.
2. **Floating distance-from-previous-stop** is neutral (null) until day-plan geo exists (11/14).
3. **No batch trigger / cron** — `runForZone` is an invokable method; the BatchAssignmentWorker
   schedule + the actual dispatch (`work_schedules`, `plant_batch_assignments`, "Day Plan is live")
   are Issue 11. `recommendations.status` is `SUGGESTED`/`UNASSIGNABLE` here; Issue 11 owns dispatch.
4. **`recommendations.status` is free text** (per schema D-sched "genuinely open"); this issue uses
   `SUGGESTED` and `UNASSIGNABLE`.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run     # 205 green (PG16 + PostGIS on :5433)
# focused: node node_modules/vitest/vitest.mjs run test/canonical-sort.spec.ts test/hard-filters.spec.ts \
#   test/scoring.spec.ts test/candidate-selection.e2e-spec.ts test/recommender-run.e2e-spec.ts
```
