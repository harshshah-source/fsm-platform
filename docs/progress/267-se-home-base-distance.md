# 267 — Admin-managed SE home/base + route-chain distance scoring (Phase 1 distance)

**Status:** DONE · 2026-08-24 · branch `feat/autoplant-integration`
**Issue:** `.scratch/fsm-platform-v1/issues/267-se-home-base-distance.md` · **Decision:** #258 Q6
(home/base → first stop → next stop; existing plant coordinates; NO live GPS in Phase 1)
**Suite at completion:** backend recommender/intraday/engineer-admin/distance/hard-filters/scoring
specs green (see §4, 128 tests across 26 files); admin `tsc --noEmit` clean, 11 SE-directory tests
green. Migration `20260824130000_se_home_base` applied to dev + test DBs.

---

## 1. What was wrong

`distanceFromPrevStopKm` was hardcoded `null` in `recommender.service.ts`'s `featuresFor`, so
`distanceScore` was always 0 while the seeded `distance` weight (0.1, active) sat there doing nothing
— the live-knob/dead-feature trap #159 exists to catch. No SE coordinates existed anywhere
(`engineer_master` had no location columns), and the batch stop-ordering seam's own docstring named
this issue as the thing that would close it.

## 2. What was built

- **Migration `20260824130000_se_home_base`**: `engineer_master.home_lat`/`home_lng`, nullable
  `DOUBLE PRECISION`, no index (Q6/AC: plain floats, not PostGIS geometry — SEs need no spatial
  indexing).
- **`recommender/distance.ts`**: `haversineKm` (unit-tested against London–Paris ≈344 km and
  Delhi–Mumbai ≈1150 km, ±1%) + the shared `NOT_AVAILABLE` sentinel (`DistanceKm = number |
  'NOT_AVAILABLE'`) — the same "never fabricate a default" convention #270's `FilterState` uses, at
  distance's own per-value grain.
- **`recommender/plant-geometry.ts`**: `plantCoordinatesForZone` — the raw-SQL PostGIS prefetch
  (`ST_Y`/`ST_X`), one query per zone-run, a plant with NULL `location` simply absent from the map
  (never `(0,0)`).
- **`recommender/scoring-config.ts`**: `readEngineerHomeBases` — every engineer's home base, global
  scope (matches `readEngineerCapacity`'s own scope), absent = no home base set.
- **`scheduling/committed-day-load.ts`**: `CommittedDayEntry` gained `lastStopPlantId` — the SE's
  last (highest `stop_sequence`) live stop's plant today, read off the SAME rows `committedDayPlan`
  already fetches for `count`/`plants` (no second query).
- **`recommender.service.ts`** (`runForZone`): plant coords + home bases fetched once at run start;
  a lazily-seeded `currentPos` map (last live stop → home base → `null`) that advances to the winning
  plant after each assignment — the "route-chain" half of Q6. `featuresFor` became per-candidate
  (`(ticket, seId)`, not `(ticket)`), matching #266 Q-A's own structural move for the cluster term.
- **`intraday-insertion.service.ts`** (#268's CRITICAL direct-assign sweep): wired identically — its
  own comment already said "deferred until #267 (unbuilt seam, same as the batch)", so this issue
  closes it there too rather than leaving distance permanently NOT_AVAILABLE on the CRITICAL path
  while the morning batch has it live. Same per-candidate `featuresFor` fix (it had reused ONE shared
  `features` object across every candidate, the identical Q-A-class bug the batch already had fixed).
- **`scoring.ts`**: `ScoreBreakdown` gained `distanceKm: DistanceKm` — the raw distance the score was
  derived from (or `NOT_AVAILABLE`), separate from `distanceScore` (the normalized 0..1 contribution)
  so the breakdown states the AC's "distance: NOT_AVAILABLE" honesty directly rather than folding it
  into an already-0 number indistinguishable from "genuinely 0 km away".
- **`engineer-admin.service.ts` + `engineers.controller.ts`**: `homeLat`/`homeLng` on create/update,
  `assertLatLng` (blank pair legal; a HALF-set pair rejected as `HOME_BASE_INCOMPLETE` — the
  fabricated-`(0,0)`-adjacent footgun the issue's AC exists to prevent; range-checked otherwise).
- **Admin SE Directory** (`SeManagementDirectoryPage.tsx`): two new `EditableCell` columns, "Home
  Lat"/"Home Lng", same click-to-edit pattern as every other field in the table — no layout change
  beyond the two fields (there is no v2-reference image for this Phase-4 CRUD page to match against;
  it already predates the v2 set and follows this table's own established column pattern).

## 3. Corrections to the issue text

- **`candidate-selection.service.ts:41-50`'s "PostGIS idiom"** is `$queryRaw` + `Prisma.sql` over a
  non-geometry join (`plant_eligible_floating_se`/`engineer_master`) — the raw-SQL *mechanism* it
  reuses is real, but that specific query never touches `ST_Y`/`ST_X` or `plants.location`. The new
  `plant-geometry.ts` is the first caller that actually reads PostGIS geometry via raw SQL.
- **The batch stop-ordering seam (`batch-assignment.service.ts`'s `orderPlantStops`) is untouched,
  deliberately.** The issue's own AC pins this ("distance never reorders tickets — canonical-order pin
  from #266 re-asserted"): `distance` shapes which SE wins within a tier, never the ORDER stops are
  visited within one SE's day plan. `orderPlantStops`'s "hook that swaps to PostGIS route-distance"
  docstring refers to a different, still-unbuilt concern (route sequencing) that this issue does not
  claim.

## 4. Tests

- `test/distance.spec.ts` (new) — haversine against two independently-known city pairs, ±1% (AC).
- `test/hard-filters.spec.ts`/#270's `evaluateAllFilters` — unaffected; `distance` is not a hard
  filter (re-confirmed, not a regression risk this issue could have introduced).
- `test/recommender-distance.e2e-spec.ts` (new, 5 tests) — nearer SE (by home base) wins the first
  assignment; chain advancement (a tied first ticket's winner is preferred for a later ticket at the
  SAME plant, via `currentPos` alone — isolates the win-then-advance mechanism from home-base
  proximity); a plant with NULL geometry → `NOT_AVAILABLE`, ticket still assigned (non-blocking); an
  SE with no home base and no prior stop → `NOT_AVAILABLE`, 0 contribution, never dropped; plant
  coordinates fetched **exactly once** per zone-run on a 3-ticket fixture (`vi.spyOn` on `$queryRaw`,
  filtered to the `ST_Y(location)` query text).
- `test/engineer-admin.e2e-spec.ts` (+3 tests) — blank home base legal; a half-set pair and an
  out-of-range coordinate rejected with the right code; an edit updates/clears the pair, and editing
  only one coordinate while the other is already on file stays legal (backfilled from the DB row).
- `apps/admin/test/se-management-directory.test.tsx` (+2 tests) — inline lat/lng edit round-trips a
  PATCH with exactly the changed field; a `HOME_BASE_INCOMPLETE` response surfaces its mapped message.
- Regression, all green: `recommender-{availability,common-kit,cross-zone-capacity,departed-source-of-
  truth,dry-run,install-backlog,mode,planner-bias,preventive-run,preventive-scoring,return-date-
  priority,run,score-selection,tier-override,trace-scores,waiting-component,filter-honesty}`,
  `intraday-insertions-controller`, `scoring`, `tier-score-chooser`, `capacity-overload-visibility`,
  `assign-console-candidates`, `candidate-selection(-coverage-drift)`. Backend and admin `tsc --noEmit`
  both clean.

## 5. What's left

None on this issue's own ACs. Data-entry dependence (the issue's own Risks section): distance reads
`NOT_AVAILABLE` uniformly until admins populate home bases — correct and visible, not a defect. Not
measured against the dev-mirror's plant geometry coverage (the issue flagged this as worth checking,
not blocking); worth a follow-up runbook line if a future session has spare capacity.
