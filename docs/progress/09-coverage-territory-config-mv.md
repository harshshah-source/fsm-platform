# Progress — Issue 09: Coverage / Territory config + Materialized Views

> Build date: 2026-06-21 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All 6 acceptance criteria green. Backend **187 tests / 56 files**, admin
> **26 tests / 11 files**, both `tsc --noEmit` clean. Local dev DB: **PostgreSQL 16 + PostGIS 3.5.3**.

## Environment switch (prerequisite)

PostGIS is a hard dependency (ADR-0006: `ST_Contains`, `geometry`, GIST, the MV). The prior sessions
ran a bare **PostgreSQL 18 on :5432** with no PostGIS — and PostGIS ships **no PG18 Windows binaries**.
CONTEXT.md actually specifies **Postgres 16 + PostGIS**, so local dev was moved to **PG16.14 + PostGIS
3.5.3 on :5433** (role/db `fsm`/`fsm`; `apps/backend/.env`). All 12 prior migrations replayed clean and
the full suite stayed green on PG16. PG18/:5432 remains as an untouched fallback. This also closes
**Issue 01 AC#2's open PostGIS clause**.

## Decisions taken

1. **AC#1 was already satisfied by Issue 02 Slice 6** — `POST /api/org/engineers` (coverage type
   DEDICATED/MULTI_PLANT/FLOATING, validated + persisted) and `POST /api/org/se-coverage` (FLOATING
   rejected → territory table). Issue 09 built the FLOATING **territory** half. Not rebuilt.
2. **Representative geography seed** — a real but small subset (Maharashtra / Gujarat / Karnataka →
   regions → districts) so the selector + demo work. The full ~700-district authoritative load is
   deferred as a separate reference-data task; the resolution logic is independent of seed breadth.
3. **MV refresh is event-driven + CONCURRENTLY** — every territory edit refreshes
   `plant_eligible_floating_se` (`REFRESH … CONCURRENTLY` via the unique index, with a plain-refresh
   fallback for the first unpopulated run). Nightly scheduling is deferred (same posture as Issue 04).
4. **Polygon membership resolves but the editor is deferred** — `ST_Contains(polygon, plant.location)`
   is in the MV and proven by test; the `polygon` column is reserved, but the map-drawing UI is a
   disabled "coming soon" affordance for v1 (AC#6). Territory is configured hierarchically.

## Summary

The Floating-SE territory model feeding the Recommender (Issue 10). Backend: PostGIS geography
(`regions`, `districts`, `plants.location`), the `engineer_territory_coverage` table (hierarchical
state/region/district AND/OR polygon, union membership, CHECK ≥1 dimension), a territory config API,
geography read endpoints, and the `plant_eligible_floating_se` materialized view resolving plant →
eligible-Floating-SE via district/region/state rollup ∪ `ST_Contains`. Admin: an Operations-Head
territory page with cascading State→Region→District selectors that build a SE's territory as a union.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Coverage types configurable + persisted | 🟢 | Issue 02 `POST /api/org/engineers` + `se-coverage`. `org-se-coverage.e2e-spec.ts`. |
| 2 | Floating territory via State/Region/District selector (union) | 🟢 | `SeTerritoryService` + `/api/org/se-territory`; `GeographyService` reads; `TerritoryPage` cascading UI. `org-se-territory.e2e-spec.ts`, `org-geography.e2e-spec.ts`, `territory-page.test.tsx`. |
| 3 | PostGIS + `geometry(MultiPolygon,4326)` + GIST present | 🟢 | `regions`/`districts`/`plants.location`/`engineer_territory_coverage` migrations; GIST on `plants.location` + `etc.polygon`. `territory-schema.e2e-spec.ts`, `territory-coverage-schema.e2e-spec.ts`. |
| 4 | MV resolves plant→eligible-floating-SE | 🟢 | `plant_eligible_floating_se` MV (district/region/state ∪ `ST_Contains`); `PlantEligibleFloatingSeService`. `plant-eligible-floating-se.e2e-spec.ts` (all 4 paths). |
| 5 | MV refresh path; resolution uses `ST_Contains` | 🟢 | `refresh()` (CONCURRENTLY + fallback), invoked on every territory edit. `territory-refresh-on-edit.e2e-spec.ts`; polygon path in slice 4. |
| 6 | Polygon-drawing deferred (schema reserved) | 🟢 | `polygon geometry(MultiPolygon,4326)` reserved; UI shows a disabled "Draw polygon (coming soon)". `territory-coverage-schema.e2e-spec.ts`, `territory-page.test.tsx`. |

## Slices delivered

- **1 — geography + PostGIS foundation**: `regions`, `districts`, `plants.location` + GIST + district FK. Migration `20260621140000_add_geography_postgis`. `territory-schema.e2e-spec.ts`.
- **2 — `engineer_territory_coverage`**: union dimensions + CHECK(≥1) + GIST(polygon). Migration `20260621150000`. `territory-coverage-schema.e2e-spec.ts`.
- **3 — territory config API**: `SeTerritoryService` + `/api/org/se-territory` (FLOATING-only, OH-scoped, audited). `org-se-territory.e2e-spec.ts`.
- **4 — `plant_eligible_floating_se` MV + resolution**: union SQL + `PlantEligibleFloatingSeService`. Migration `20260621160000`. `plant-eligible-floating-se.e2e-spec.ts`.
- **5 — MV refresh path**: CONCURRENTLY-with-fallback `refresh()`, wired into territory add/remove. `territory-refresh-on-edit.e2e-spec.ts`.
- **6 — geography reads + admin selector UI**: `GeographyService` + `/api/org/geo/*`, representative seed, `TerritoryPage` (cascading selectors, current-territory list, deferred polygon). `org-geography.e2e-spec.ts`, `org-seed.e2e-spec.ts`, `territory-page.test.tsx`.

## Deviations / deferred (read before extending)

1. **No scheduler** — `PlantEligibleFloatingSeService.refresh()` runs on territory edits but has no
   nightly cron yet (the LLD's nightly MV refresh lands with the scheduling/BullMQ work).
2. **Representative geography seed only** — full ~700-district authoritative load is a separate task.
   The selector + MV work against whatever geography is seeded.
3. **Polygon set only via raw SQL / API, not drawn** — the `polygon` column + `ST_Contains` path are
   live, but there is no map-drawing editor (AC#6). The territory API exposes hierarchical dimensions;
   polygons would be ingested by a later spatial-editor issue.
4. **`plants.location` is unset for seeded plants** — geometry is populated per-plant by ingestion /
   admin later; the MV's spatial path simply matches nothing until a plant has a location.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run     # 187 green (PG16 + PostGIS on :5433)
cd apps/admin   && node node_modules/vitest/vitest.mjs run     # 26 green
# Operations Head → Coverage (nav) → pick a FLOATING SE → State/Region/District → Add to territory.
```

Note: PostGIS migrations are hand-written raw SQL (`CREATE EXTENSION` is a per-database superuser
bootstrap, done out-of-band; the app role is not superuser). Run the vitest/prisma/tsc binaries
directly via `node node_modules/...` (FortiGate blocks pnpm's network deps-check).
