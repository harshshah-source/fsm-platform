# 233 — Commissioning cohort counts warehouse devices as failed installs

**Completed 2026-08-13.** Backend-only. Frozen completion record — corrections go to INDEX /
SYSTEM-STATE, not here.

Issue: `.scratch/fsm-platform-v1/issues/233-commissioning-cohort-counts-warehouse-as-failed.md`
Origin: `audit/recently-commissioned-devices-investigation-2026-08-13.md` §3.2

---

## What was wrong

`CommissioningAggregationService.gradedSource` joined `device_commissioning` to `device_states` with
**no operational-fleet predicate**, so a device returned to a warehouse — silent because it is in a
box — was graded as a failed install. Same defect class as #176 on the dashboard: a numerator that
excludes departed devices structurally over a denominator that does not.

It survived 35 green tests because **every fixture device was operational**. No fixture could have
caught it. That is the whole reason #232's AC-2 ("validate against live `fsm`") existed, and it had
sat unexecuted for three days.

## What changed

| File | Change |
|---|---|
| `src/reports/commissioning-aggregation.service.ts` | `population` filter on `gradedSource`; census columns; `CommissioningPopulation` + `CommissioningPopulationCensus` types; zero-fitment groups dropped from the breakdowns |
| `src/reports/reports.controller.ts` | `?population=` on both endpoints, `parseEnum` against `POPULATIONS`, default `operational` |
| `test/commissioning-cohort.e2e-spec.ts` | +7 tests, +5 fixtures (2 warehouse, 1 operational, 1 deactivated-plant, 1 unmirrored) |
| `test/probes/commissioning-population.probe.ts` | **new** — the live-`fsm` probe (see below) |
| `vitest.probe.config.ts` | **new** — probe config, deliberately separate from the suite |

**No migration, no schema change, no new index, no new job, no writer.**

Three implementation decisions worth not re-litigating:

- **`EXCLUDE_DEACTIVATED_PLANTS` is imported from `dashboard.service.ts`, not restated.** It is
  authored as a WHERE fragment (opens with `AND`), so it is anchored on `TRUE` to be usable as a bare
  boolean. Anchoring is what allows the import; copying it without its conjunction would have been the
  second spelling #176 closed. `FLEET_COUNT_COLUMNS` was **not** modified — it drives the dashboard KPI
  strip, zone rows, company×plant rows, Fleet Directory and Ops Explorer reconciliation.
- **The population gate lives in one place** — `in_population` in the `graded` CTE, folded into the
  same `CASE` that gates the TTFR epoch. `count(ttfr_hours)` therefore needs no `FILTER` at any call
  site: one gate, not two spellings of it.
- **`deactivatedPlant` in the census is a remainder, not its own `count(*) FILTER`.** Computed that
  way the four parts sum to `fitmentsInWindow` by construction, so the census cannot claim a partition
  it does not have. A fifth category appearing at source shows up as a negative remainder — visible —
  rather than as a silently unbalanced total.

## Acceptance criteria

| AC | Status | Evidence |
|---|---|---|
| AC-1 default `operational`; live totals move | ✅ | live `fsm`: **6,810 / 2,655 failed (39.0%)** → **2,623 / 136 failed (5.2%)** |
| AC-2 `population=all` reproduces today's numbers | ✅ | all 35 pre-existing tests pass unchanged; `all` is the literal `TRUE`, not a second query path |
| AC-3 partition identity | ✅ | fixture test + live: `2,623 + 4,187 + 0 + 0 = 6,810` |
| AC-4 census reported, drop named | ✅ | `population` block on the cohort payload; proven not to move with the filter |
| AC-5 `dashboard-kpi-reconciliation` green | ✅ | 16/16 (the doc's "14" is stale — the spec has grown) |
| AC-6 figures measured against live `fsm` | ✅ | this table, via `test/probes/` |

## Live `fsm` validation (2026-08-13)

Run through the **real service**, not a hand-copied query:

```
#233 live fsm, 90-day cohort
  all         fitments=6810 online=4004 pending=151 failed=2655 (39.0% failed)
  operational fitments=2623 online=2358 pending=129 failed=136  ( 5.2% failed)
  census      {"fitmentsInWindow":6810,"operational":2623,"warehouse":4187,
               "deactivatedPlant":0,"unmirrored":0}
  ttfr        median=14.61h p95=29.16h n=398
  round trip  21 ms  (server-side EXPLAIN measured 23.9 ms, all buffers cached, quicksort in memory)

#233 live fsm, installers(90d, n>=30):
  all=40 rows worst=1.000 · operational=26 rows worst=0.545
```

**The installer line is the sharpest single result.** The worst installer in the pre-fix view had a
**100% never-online rate**; under the operational population it is 54.5%. That row was *entirely
warehouse devices* — a leaderboard that would have named someone for failures that never happened.

`deactivatedPlant` and `unmirrored` are 0 on the live mirror today, which is why the fixture
manufactures both: a branch nothing exercises is a branch nothing protects.

## Testing

| Suite | Result |
|---|---|
| `commissioning-cohort.e2e-spec.ts` | **34** (was 27) |
| `commissioning-units.spec.ts` | 8 |
| `device-commissioning.e2e-spec.ts` | 8 — append-only + `indnullsnotdistinct` guard intact |
| `dashboard-kpi-reconciliation.e2e-spec.ts` | 16 — the untouched-neighbour tripwire |
| `setup-env-allowlist.spec.ts` | 5 |
| `ops-explorer.e2e-spec.ts` + `ops-explorer-query.spec.ts` | 20 + 44 — the other importer of the same predicates |
| **Total** | **135 across 7 files, exit 0** |
| `test/probes/commissioning-population.probe.ts` | 3, against live `fsm` |
| `tsc --noEmit -p tsconfig.json` | clean |
| `tsc --noEmit -p tsconfig.test.json` | 93 errors, **all pre-existing**, none in `reports/`, `dashboard/`, commissioning or the probe (baseline unchanged before and after) |

Per-file runs, not a bare "full suite green" claim — #156 established that signal is unreliable on a
local box.

### On `test/probes/`

A new, deliberately separate lane. `vitest.config.ts` guarantees the suite can never touch a live
database — `_test` suffix, migrate, seed, #182 env allowlist — and none of that is relaxed. A probe is
not a test: it asserts properties of a **mutating AutoPlant mirror**, so it cannot be a green/red gate
and must never be collected by the default run. The two are kept apart by directory and extension
(`test/probes/*.probe.ts` cannot match `**/*.{spec,e2e-spec}.ts`).

Its assertions are **relations between two runs**, not the literal figures above — a frozen literal
would fail on the next master sync and teach the next reader to delete the test.

```
pnpm --filter backend exec vitest run --config vitest.probe.config.ts
```

## Follow-ups this did not close

- **#234** — the cohort resolution curve. Shares `gradedSource`, which is why it sequences after this.
- **#232 AC-1** — the admin surface, still unbuilt. This unblocks it.
- **#232 AC-3** — `kpiCatalog` / `kpi-definitions.md` entries, riding with the page.
- **Not a regression, but noted:** `tsconfig.test.json` carries 93 pre-existing errors. SYSTEM-STATE
  records that `test/**` was brought under typechecking on 2026-08-09; it is not currently clean.
  Unowned.
