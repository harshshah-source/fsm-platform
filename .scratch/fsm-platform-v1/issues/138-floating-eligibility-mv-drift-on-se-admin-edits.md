# 138 — FLOATING-SE eligibility MV drifts on internal SE/plant admin edits (recommender dispatches on stale coverage)

Status: done
Type: backend defect (latent — floating leg dormant on dev; mechanism proven live)

> **DONE 2026-07-21** — all three slices landed (TDD). Slice 1: floating leg re-checks
> `coverage_type`/`is_active` live (`candidate-selection.service.ts`). Slice 2: master-sync refreshes
> the MV after a successful run (`master-sync.service.ts`, best-effort `@Optional()` collaborator).
> Slice 3: `PlantEligibilityRefreshScheduler` periodic backstop (`src/org/`, beside DispatchScheduler,
> in `OrgModule`). See the per-slice notes below.

## Triage (2026-07-21) — sliced; Slice 1 in progress

Triaged `ready-for-agent`. The fix splits along the two independent drift sources:

- **Slice 1 (in progress this session) — live source-of-truth re-filter (closes AC#1).** In
  `candidate-selection.service.ts` the FLOATING leg JOINs `engineer_master` and keeps only
  `coverage_type='FLOATING' AND is_active=true`. This makes the coverage-type-flip and deactivate drift
  correct **regardless of MV freshness** — the MV becomes a pure territory-geometry index and identity is
  always read live. Isolated to one file (`candidate-selection.service.ts`), which is clean in the
  working tree (the concurrent NEW-A1 change to `recommender.service.ts` is untouched). TDD at the
  `orderedCandidatesForPlant` seam.
- **Slice 2 — geometry-side freshness (AC#2). DONE.** Investigation reframed the seam: there is **no
  interactive** writer of MV geometry (`plants.service.ts` create sets only name+zone → never
  floating-eligible; `zone-mapping` only writes `zone_id`, which the MV doesn't use). The **only** bulk
  writer of `plants.district_id`/`location` is **master-sync**. So the refresh hooks the master-sync run
  boundary: `master-sync.service.ts` now calls `PlantEligibleFloatingSeService.refresh()` after a SUCCESS
  run, as a best-effort `@Optional()` collaborator (mirrors the Issue-128 departure pass — a refresh
  failure is logged and swallowed, never fails the committed mirror). `OrgModule` imported into
  `IngestionModule` (cycle-safe: org→audit only).
- **Slice 3 — periodic backstop (AC#3). DONE.** New `PlantEligibilityRefreshScheduler` (`src/org/`) — a
  standalone `@Cron` that `REFRESH`es the MV, gated by `BUSINESS_SWEEPS_ENABLED` (the same gate as the
  dispatch it feeds), default `30 4 * * *` (before the 05:00 dispatch), env-overridable via
  `PLANT_ELIGIBILITY_REFRESH_CRON`. **Design:** it sits *beside* the #108 business sweeps rather than as
  an 11th collaborator on `BusinessSweepSchedulerService` — the same reasoning `DispatchSchedulerService`
  already follows — so it added no ripple to that scheduler's 6 construction sites. Registered as a
  factory provider in `OrgModule`. This also heals the Pattern-2 post-commit-refresh orphan (a lost
  territory-edit refresh is picked up on the next tick).

### Slices 2 & 3 — DONE 2026-07-21 (TDD)

- Slice 3: `plant-eligibility-refresh-scheduler.e2e-spec.ts` (6 tests — config default/override, refresh
  when enabled, dormant when off, throw→ERROR never escapes cron, single-in-flight guard, cron
  registration). Mirrors `dispatch-scheduler.e2e-spec.ts`.
- Slice 2: `master-sync-eligibility-refresh.e2e-spec.ts` (3 tests — refresh called once on SUCCESS;
  refresh failure swallowed (sync still SUCCESS); no-op/no-throw when the collaborator is absent).
- Regression: 154 tests green across candidate/floating/territory/recommender/dispatch/integration/
  ingestion/wiring + the new suites; backend `tsc` clean. (One unrelated **pre-existing** failure,
  `integration-reconciliation` SQL-shape, is an Issue-128 operational-vs-deployment status test
  divergence in code this change never touches — left alone per concurrent-tree discipline.)

Rationale: Slice 1 is the highest-value, lowest-risk cut — it fully closes the *undefended* headline leg
(coverage-type flip) and the is_active leg without depending on MV refresh, and touches only a clean file.

### Slice 1 — DONE 2026-07-21 (TDD)

`candidate-selection.service.ts` FLOATING leg now `JOIN engineer_master … WHERE coverage_type='FLOATING'
AND is_active=true`, so a stale MV row can no longer resurrect a now-DEDICATED or deactivated SE.
RED→GREEN at the `orderedCandidatesForPlant` seam (`candidate-selection-coverage-drift.e2e-spec.ts`,
3 tests): control (active FLOATING SE is a candidate), then a coverage-type flip to DEDICATED and a
deactivate — each **without** an MV refresh — must drop the SE. RED reproduced both (stale MV still
returned the SE); GREEN after the join. Regression: 47 recommender/candidate/floating/territory + 52
dispatch tests green, backend `tsc` clean. Slices 2 (geometry refresh) + 3 (periodic backstop) remain
open on this issue.

> Source: `docs/audits/pattern-tracing-audit-2026-07-21.md` **NEW-A3** (headline), reframed after the
> correction that SE data is FSM-internal admin data (entered via `/engineers/manage` →
> `SeTerritoryService` / `EngineerAdminService`), **not** an AutoPlant source. The drift risk is therefore
> internal to FSM's own admin flows — a routine OH action, not a rare external event.

## Pattern

Pattern 1 — a write path (the recommender's FLOATING candidate leg) trusts a **derived artifact** (the
`plant_eligible_floating_se` materialized view) as its sole gate, without re-consulting the source of
truth (`engineer_master.coverage_type` / `is_active`, and current plant geography) at dispatch time.
Plus a Pattern-2 leg: the MV's only refresh is a best-effort **post-commit** call.

## Where (both sides of the trust boundary)

- **Trust side:** `recommender/candidate-selection.service.ts:35-38` reads FLOATING candidates straight
  from `plant_eligible_floating_se`; consumed at dispatch time by `recommender.service.ts:182`
  (`orderedCandidatesForPlant`). The DEDICATED/MULTI_PLANT legs read `se_coverage` **live** (`:24-33`) —
  source of truth, clean. Only FLOATING trusts the MV.
- **The MV cannot see coverage_type or is_active.** Live view definition (from the dev DB, not just the
  migration):
  ```
  SELECT DISTINCT p.plant_id, etc.se_id
  FROM plants p
  LEFT JOIN districts d ON d.district_id = p.district_id
  JOIN engineer_territory_coverage etc ON (district_id / region_id / state / ST_Contains match)
  ```
  It joins **`plants × engineer_territory_coverage` only** — no `engineer_master` reference. So a row's
  presence depends purely on the SE having a territory row, **regardless** of whether that SE is still
  FLOATING or still active.
- **Refresh side:** the MV is refreshed **only** by `org/se-territory.service.ts:91,113`
  (`addTerritory` / `removeTerritory`), and always as a **best-effort, post-commit**
  `this.eligibility.refresh()` run *outside* the audit tx (`plant-eligible-floating-se.service.ts:18-24`
  — `REFRESH … CONCURRENTLY` can't run in a tx). Repo-wide grep for `.refresh(` / `REFRESH MATERIALIZED`
  confirms **no other caller** and **no scheduled/nightly refresh** (only the seed, `org/org-seed.ts:240`).

## SE-table writers and whether they refresh the MV

| Writer | Table / field written | Feeds the MV? | Refreshes MV? |
|---|---|---|---|
| `SeTerritoryService.addTerritory` / `removeTerritory` (`se-territory.service.ts:79,109`) | `engineer_territory_coverage` | **yes** (the MV's only SE input) | **yes** (`:91`/`:113`, post-commit best-effort) |
| `EngineerAdminService.editEngineer` (`engineer-admin.service.ts:201`) | `engineer_master.coverage_type` (+ capacity/zone) | MV ignores the field, but a FLOATING→DEDICATED flip should drop the SE from floating eligibility | **no** |
| `EngineerAdminService.setActive` (`engineer-admin.service.ts:228`) | `engineer_master.is_active` | MV ignores the field | **no** |
| `SeCoverageService` / `EngineerAdminService.addCoverage` (`se-coverage.service.ts:137`, `engineer-admin.service.ts:259`) | `se_coverage` | **no** (DEDICATED/MULTI_PLANT read live) | n/a (correct) |
| plant CRUD / master-sync | `plants.district_id` / `location`, `districts.region_id` / `state` | **yes** (plant→SE mapping) | **no** |

**Net:** the one SE table that feeds the MV (`engineer_territory_coverage`) *is* wired to refresh. The
gaps are (a) `coverage_type` / `is_active` changes that the MV structurally can't reflect, and (b) plant/
district geography changes that never refresh.

## Two failure legs, and which is defended

1. **`coverage_type` flip — UNDEFENDED (the real bug).** `editEngineer` flips FLOATING→DEDICATED
   (`:201`) but does **not** remove the SE's `engineer_territory_coverage` rows and does **not** refresh.
   The SE therefore stays in the MV as a FLOATING candidate. The recommender's readiness pass
   (`recommender.service.ts:191-202`) re-checks `is_active` (`:197`), availability, capacity and kit —
   but **never coverage_type**. So a now-DEDICATED SE keeps getting dispatched as a floating candidate to
   their entire former territory (wasted truck rolls — the #128 class).
2. **`is_active=false` (deactivate) — LATENT/defended.** `setActive` (`:228`) leaves territory rows +
   MV row in place, but the readiness `available` check reads `engineer_master.is_active` live
   (`:197`), so an inactive SE is dropped downstream. Drift exists in the MV; the outcome is corrected.
3. **New/relocated plant — UNDEFENDED (opposite direction).** A new plant, or a plant whose
   district/location changes, is absent/wrong in the MV until an unrelated territory edit rebuilds it →
   its tickets get **zero** floating candidates → spurious `NO_COVERAGE` UNASSIGNABLE.

## Confirmation on the dev DB (2026-07-21)

Read-only, plus one rolled-back simulation (`scratchpad/confirm-findings.cjs` / `confirm2.cjs`).

- **Counts:** `mv_rows=0, mv_ses=0, floating_ses=0, nonfloating_ses=75, inactive_ses=0,
  territory_rows=0, ses_with_territory=0`. → **The entire floating leg is dormant on dev**: the mock seed
  created only DEDICATED/MULTI_PLANT SEs, so the MV is empty and this path has never been exercised.
  Hence the finding is **LATENT on current data**, not live.
- **Mechanism proven live (rolled-back tx):** inserted one `engineer_territory_coverage` row (district 7)
  for an existing **DEDICATED, active** SE (`1f5bc147-…`), `REFRESH`ed the MV, and it appeared with
  `mv_rows_for_se=2`, `covers_target_plant=true`, `coverage_type=DEDICATED`. `ROLLBACK` restored
  `mv_rows=0` (no dev-DB side effect). → confirms the MV lists an SE **purely** from a territory row,
  never consulting `coverage_type`/`is_active`; and the DB has **no CHECK** requiring territory-row SEs to
  be FLOATING (`migrations/20260621150000…:4-27`; FK is `ON DELETE RESTRICT`).

**Verdict:** CONFIRMED mechanism; LATENT until the first FLOATING SE + territory exists and is then
edited (coverage-type change) — or the first post-refresh plant onboarding.

## Blast / likelihood

- **Blast:** wrong-SE floating dispatch across a whole territory (leg 1) or a plant with no floating
  coverage at all (leg 3). Bounded to entities changed since the last refresh; unbounded in time (nothing
  self-heals without a territory edit).
- **Likelihood post-activation:** MED — creating/editing SEs and onboarding plants are routine OH ops,
  and the daily dispatch cron consumes the MV every morning. Masked today only because dispatch is off
  and no floating SEs are seeded.

## Proposed fix approach (given the internal-data reframing — for triage, NOT built here)

Because the inputs are FSM-internal, prefer a **source-of-truth re-check** over external reconciliation
(the NEW-C1 fix family), which closes the SE-side drift regardless of MV freshness:

1. **Re-filter the floating leg live.** In `candidate-selection.service.ts:35-38`, join the MV to
   `engineer_master` and keep only `coverage_type='FLOATING' AND is_active=true`. This makes leg 1
   (coverage-type flip) and leg 2 (deactivate) correct **without** depending on the MV being fresh — the
   MV becomes a pure territory-geometry index, and identity is always read live. Cheapest, most robust.
2. **Refresh on the geometry inputs + a periodic safety net** for leg 3: route plant create/relocate and
   district re-parent through one `refreshEligibility()` seam, and add a nightly
   `REFRESH MATERIALIZED VIEW CONCURRENTLY` business-sweep tick (also heals the post-commit orphan leg).
3. Optional hygiene: when `editEngineer` flips FLOATING→non-FLOATING, delete the SE's territory rows in
   the same tx (keeps the MV honest even without step 1).

## Acceptance criteria (draft — triage owns)

- [x] The recommender never returns a floating candidate whose current `engineer_master.coverage_type ≠
      FLOATING` or `is_active = false`, proven by a test that flips coverage-type/active **without** a
      territory edit and asserts the SE drops from the pool. **(Slice 1, done 2026-07-21.)**
- [x] A newly-created plant (or a district/location change) yields correct floating candidates without
      requiring an unrelated territory edit. **(Slice 2 — master-sync post-run refresh, done 2026-07-21.)**
- [x] The MV refresh has a periodic backstop (no permanent staleness if a post-commit refresh is lost).
      **(Slice 3 — `PlantEligibilityRefreshScheduler`, done 2026-07-21.)**

## Dependencies / notes

- Gated by `BUSINESS_SWEEPS_ENABLED` for real impact (dispatch off today). Related: #128 (wasted-roll
  class), #127 (per-SE isolation). No fix in this session (audit → triage contract).
