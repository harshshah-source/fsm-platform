# 176 — Dashboard KPI transparency: one operational population, named and reconciled

Status: **DONE 2026-07-29.** All 10 deliverables landed; reconciliation verified against the live dev
DB (master sync run 90) and encoded as permanent tests.
Type: AFK · Backend + Admin (one vertical slice)

Operator ask 2026-07-29, following an investigation into inconsistent dashboard figures.

## The problem

The dashboard reported:

- Total Devices **50,270**
- Active Fleet **17,415**
- Inactive Devices **3,476**

while Zone Overview and Company Overview divided by a denominator totalling **23,238**.

Investigation (`docs/kpi-definitions.md` §6) traced it to three populations mixed across four
surfaces:

- `DashboardService.fleetSummary` counted `is_departed = false` — **operational**.
- `DashboardService.zoneOverview`'s totals query had **no** `is_departed` predicate — operational **+
  warehouse**.
- Its numerator excluded departed devices *structurally* (`DeviceStateService.recompute` sets
  `is_inactive = NOT departed AND …`), so `inactive / total` divided an operational numerator by a
  mixed denominator.

`companyPlantOverview` and `fleetDirectory` carried the same omission; `fleetDirectory`'s docstring
explicitly claimed reconciliation with the Active Fleet KPI (23,238 vs 17,415) that it never had.

**Impact.** Warehouse stock is unevenly distributed (West 14.7% departed, South 39.4%), so the
distortion re-ordered the Zone Performance Scorecard — a league table. South read 21.4% inactive
against an actual 35.2%.

A second, latent defect surfaced during the fix: zone and company×plant rows were built from the
*inactive* query, so an entity with a fleet but zero inactive devices vanished from the table
entirely, taking its operational devices out of the column totals.

## What landed

### Backend (`apps/backend/src/dashboard/`)

1. **One shared aggregate.** `FLEET_COUNT_COLUMNS` — five `COUNT(*) FILTER` columns selected by every
   level (fleet / zone / company×plant / company / plant), differing only in `GROUP BY`. Makes the
   numerator-vs-denominator drift class unrepresentable rather than merely fixed.
2. **Rows driven by the population, not the problem.** Zone and company×plant rows now come from the
   counts query; a healthy entity renders `0 / N`. Company×plant rows 135 → 205 live.
3. **`fleetSummary`** extended with the operational breakdown, `catalogDevices` (renamed from
   `sourceDevices`), `lastMasterSyncAt`, `lastSnapshotAt`.
4. **`fleetDirectory`** gains the full breakdown plus `lastSnapshotAt` / `lastActivityAt` per entity.
5. **New `GET /api/dashboard/fleet-composition`** — the funnel, with every drop named and counted;
   zone-scoped callers get `catalogDevices: null` (no zone attribution exists for a source counter).

### Admin (`apps/admin/src/`)

6. **`lib/kpiCatalog.ts`** — one registry of every KPI: name, family (source / operational / derived),
   definition, counts, excludes, source table, refresh trigger, formula, reconciliation identity.
   Drives both the tooltips and `docs/kpi-definitions.md`.
7. **`components/data/KpiInfo.tsx`** — the info affordance on every KPI card and counted column
   header. Hover + focus + click-to-latch, Escape/outside-click to dismiss, `aria-describedby`.
   Zero-dependency, matching the house `icons.tsx` style.
8. **Renames.** "Total Devices" → **AutoPlant Catalog** (sync timestamp on the card); "Active Fleet" →
   **Operational Fleet**; "Inactive Devices" → **Inactive Operational Devices**; "Inactive / Total" →
   **Inactive Operational**.
9. **Two new sections** on all three manager dashboards: **Operational Fleet** (6 KPIs over one
   population) and **Fleet Composition** (the funnel).
10. **Table columns.** Zone Overview, Zone Scorecard, Company/Plant Overview and Fleet Directory all
    gain Operational · Warehouse · Healthy · Inactive % · Fleet Health %; the Directory also gets
    Mirrored · Last Snapshot · Last Activity. Exports updated to match.

## Decisions taken

- **D-1: per-entity "AutoPlant Devices" is not buildable — ship "Mirrored Devices" instead.** *(HITL,
  2026-07-29.)* The catalog total is a single global counter in `master_sync_runs.entity_stats`; the
  non-mirrored source rows are never persisted with a plant, so no per-company/plant catalog figure
  exists. Options were (a) mirrored devices, (b) an ingestion change to persist per-plant observed
  counts, (c) omit. **(a) chosen** — it is what FSM actually holds, it reconciles exactly, and it does
  not require an ingestion change that would back-fill nothing. Recorded as a known limitation in
  `docs/kpi-definitions.md` §7.
- **D-2: business logic untouched.** "Inactive" keeps its exact predicate
  (`is_inactive AND sla_bucket IS NOT NULL`); the threshold, SLA bands, departure semantics and
  deactivated-plant exclusion are unchanged. Only denominators, row construction, naming and
  presentation moved.
- **D-3: `healthyOperational` is counted, not subtracted** — the complement predicate over the same
  non-departed set, so `healthy + inactive = operational` holds structurally.
- **D-4: the catalog steps are omitted from a ZM's funnel** rather than shown pan-India, which would
  repeat the category error being removed.

## Tests

| Suite | Result |
|---|---|
| `apps/backend/test/dashboard-kpi-reconciliation.e2e-spec.ts` (new, 14 tests) | green |
| `apps/backend/test/dashboard-{total-devices,zone-overview,company-plant}.e2e-spec.ts` | green (24 total) |
| `apps/admin/test/kpi-transparency.test.tsx` (new, 14 tests) | green |
| `apps/admin` full suite | **367 passed / 87 files** |
| `tsc --noEmit`, both apps | clean |

The reconciliation spec asserts the identities over the **whole database**, not a fixture — it would
have failed on the pre-fix code with the production dataset loaded.

## Live verification (dev DB, master sync run 90, 2026-07-29)

All 14 identity checks pass. Headline: catalog 50,270 → mirrored 24,225 (−26,045 never mirrored) →
on live plants 23,238 (−987 deactivated plants) → operational 17,415 + warehouse 5,823; operational
splits 13,939 healthy + 3,476 inactive. Full per-zone table in `docs/kpi-definitions.md` §5.

## Follow-ups

None blocking. The per-entity AutoPlant attribution (D-1) is a documented limitation, not a deferral —
file a new issue if the operator wants the ingestion change.
