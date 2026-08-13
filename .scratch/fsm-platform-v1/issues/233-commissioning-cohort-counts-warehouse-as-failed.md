# 233 — Commissioning cohort counts warehouse devices as failed installs

Status: **done 2026-08-13** — all six ACs checked, validated against live `fsm`.
Report: `docs/progress/233-commissioning-population.md`
Type: Defect (Backend-only) · Reports · AFK
Filed: 2026-08-13, from `audit/recently-commissioned-devices-investigation-2026-08-13.md` §3.2 —
which is [#232](./232-commissioning-cohort-view.md)'s **AC-2** ("validate against live `fsm`")
finally being executed. It failed.
Blocks: [#232](./232-commissioning-cohort-view.md) AC-1 (the admin surface)
Coordinates with: [#176](./176-kpi-transparency-operational-population.md) (the same defect class, closed on the dashboard) ·
[#217](./217-operations-data-explorer.md) (whose `reconciliation.service.ts` is the import precedent)

## What to build

`CommissioningAggregationService.gradedSource` (`apps/backend/src/reports/commissioning-aggregation.service.ts:170`)
selects every `device_commissioning` row joined to `device_states` with **no operational-fleet
predicate**. It counts devices that have been returned to a warehouse as failed installs.

Measured live on `fsm`, 2026-08-13, last 90 days:

| | fitments | online | pending | failed | failure rate |
|---|---:|---:|---:|---:|---:|
| As computed today | **6,832** | 4,014 | 150 | **2,668** | **39.1%** |
| `ds.is_departed = false` | **2,645** | 2,368 | 130 | **147** | **5.6%** |

**4,127 of the 6,405 cohort devices (64.4%) are departed.** A departed device is silent because it is
in a box, not because its install failed. This is exactly the defect #176 closed on the dashboard —
a numerator that excludes departed devices structurally over a denominator that does not — recreated
in a new surface, and unnoticed because no screen calls these endpoints.

**The fix:** a `population` filter on `gradedSource`, defaulting to `operational`.

| `population` | Predicate | Meaning |
|---|---|---|
| `operational` *(default)* | `ds.is_departed = false` **and** `EXCLUDE_DEACTIVATED_PLANTS` | devices in the field — the install-quality measure |
| `all` | no predicate (today's behaviour) | every fitment, warehouse included; reconciliation / audit only |

**Import the predicates from `dashboard/dashboard.service.ts`; do not restate them.** Both
`EXCLUDE_DEACTIVATED_PLANTS` (`:8`) and the `is_departed = false` predicate behind
`FLEET_COUNT_COLUMNS` (`:84`) are already exported for exactly this, and `reconciliation.service.ts`
imports them rather than spelling them again. A checker written from a second spelling only verifies
that the second spelling agrees with itself.

**Do NOT modify `FLEET_COUNT_COLUMNS` or `EXCLUDE_DEACTIVATED_PLANTS.`** They drive the dashboard KPI
strip, zone rows, company×plant rows, the Fleet Directory and Ops Explorer reconciliation. Import and
use; never edit.

Blast radius is **zero**: nothing consumes these two endpoints — no `apps/admin/src/api/reports.ts`
entry, no page, no test outside the module. That is precisely why this must land **before** #232's
admin surface, not after.

## Acceptance criteria

1. **AC-1** Both `/api/reports/commissioning/cohort` and `/installers` accept `population` and default
   to `operational`. Against live `fsm` at `cohortDays=90`, totals move 6,832 → 2,645 fitments and
   2,668 → 147 failed.
2. **AC-2** `population=all` reproduces today's numbers exactly — the regression floor for the
   existing 27 `commissioning-cohort` tests.
3. **AC-3** A partition-identity test asserts `operational + warehouse = all` over the same window
   (the §2.8 identity, checked the way `reconciliation.service.ts` checks its six), not a second
   spelling of the predicate.
4. **AC-4** The payload reports the operational **and** warehouse counts, so the drop is named rather
   than silent — the Fleet Composition "name every drop" pattern.
5. **AC-5** `apps/backend/test/dashboard-kpi-reconciliation.e2e-spec.ts` (14 tests, whole-database)
   still green — the proof that nothing shared moved.
6. **AC-6** The completion report records the figures **measured against live `fsm`**, not only
   fixture greens. #232's AC-2 sat unexecuted for three days and this defect is what was behind it.

## UI surfaces

n/a — backend-only. The surface these numbers reach is [#232](./232-commissioning-cohort-view.md) AC-1.

## Reference

n/a.

## Blocked by

Nothing. Buildable now.
