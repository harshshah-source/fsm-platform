# 09 — Coverage / territory config + materialized views

Status: done
Type: AFK
Progress: DONE (2026-06-21) — strict TDD slices 1–6. Backend 56 files / 187 tests, admin 11 files /
26 tests, both tsc clean. Env: switched local dev to PostgreSQL 16 + PostGIS 3.5.3 on :5433 (PG18 had
no PostGIS Windows binaries; CONTEXT.md specifies PG16) — this also closes Issue 01 AC#2's open PostGIS
clause. Decisions: (a) AC#1 already satisfied by Issue 02 Slice 6; (b) representative geography seed
(real subset — Maharashtra/Gujarat/Karnataka), full ~700-district load deferred as a reference-data
task; (c) MV refreshes CONCURRENTLY (plain fallback for first run) on every territory edit. Polygon
membership resolves via ST_Contains but the map-drawing editor is deferred (schema reserved).
See docs/progress/09-coverage-territory-config-mv.md.

## What to build

The SE coverage and Floating-SE territory model that feeds the Recommender. `se_coverage` for DEDICATED / MULTI_PLANT / FLOATING engineers. Floating-SE territory configured via a hierarchical selector (State / Region / District) with union membership (`engineer_territory_coverage`); a pre-computed materialized view (`plant_eligible_floating_se`) resolves which Floating SEs cover each plant using PostGIS `ST_Contains` against `geometry(MultiPolygon,4326)` territory geometry. The map polygon **drawing** editor is out of scope for v1 (hierarchical selectors only); the schema must still store polygon geometry for later.

End-to-end: Operations Head configures a Floating SE's territory hierarchically; the MV resolves the set of plants that SE covers, queryable by the Recommender.

## Acceptance criteria

- [x] SE coverage types (DEDICATED / MULTI_PLANT / FLOATING) configurable and persisted
- [x] Floating-SE territory set via State / Region / District hierarchical selector (union membership)
- [x] PostGIS extension + `geometry(MultiPolygon,4326)` columns with GIST indexes present
- [x] `plant_eligible_floating_se` materialized view resolves plant→eligible-floating-SE correctly
- [x] MV refresh path implemented; resolution uses `ST_Contains`
- [x] Polygon-drawing editor explicitly deferred (schema reserved)

## Blocked by

- #02
