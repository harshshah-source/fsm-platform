# 267 — Admin-managed SE home/base + route-chain distance scoring (Phase 1 distance)

Status: ready-for-agent
Type: AFK · Backend + Admin
Decision: #258 Q6 (home/base → first stop → next stop; existing plant coordinates; NO live GPS in
Phase 1)

## Objective

The `distance` score component gets a real feed: distance from the SE's current position in their
accumulating day route (home/base before the first stop, last planned plant after) to the candidate
ticket's plant.

## Current behaviour (verified)

- `distanceFromPrevStopKm: null` hardcoded (`recommender.service.ts:571`) → `distanceScore` always
  0 (`scoring.ts:63-66`), while an ACTIVE seeded `distance` weight of 0.1 exists (`org-seed.ts:77`)
  — the exact live-knob/dead-feature trap #159 vetoes.
- **No SE coordinates exist anywhere**: `engineer_master` (`schema.prisma:242-280`) has no location
  columns. `plants.location` (PostGIS geometry) exists and already feeds the floating-eligibility MV.
- The batch stop-ordering seam explicitly awaits this (`batch-assignment.service.ts`
  `orderPlantStops` docstring: "the hook that swaps to PostGIS route-distance once day-plan geo
  exists").

## Required change

1. `engineer_master.home_lat DOUBLE PRECISION NULL`, `home_lng DOUBLE PRECISION NULL` — plain
   columns (the MV precedent uses geometry, but SEs need no spatial indexing; two floats keep the
   admin form and API trivial). Nullable: an SE without a home base scores distance as
   NOT_AVAILABLE, never a fabricated 0-distance advantage.
2. **Plant coordinates must be read with raw SQL — Prisma cannot see them.** `plants.location` is
   `Unsupported("geometry(Point, 4326)")` (`schema.prisma:352`), invisible to the generated client.
   Prefetch **once per zone-run** and cache in run state:
   ```sql
   SELECT plant_id, ST_Y(location) AS lat, ST_X(location) AS lng
   FROM plants WHERE zone_id = $1
   ```
   Cost is bounded by plants-per-zone, not tickets — never query per ticket or per candidate. The
   `$queryRaw` + PostGIS idiom already exists in `candidate-selection.service.ts:41-50`.
3. Recommender run-state: per SE, track `currentPos` — seeded from the LAST stop of the SE's
   existing live schedule for the day (reuse the APPEND lookup's plant id, then the prefetched
   coordinate map), else home base, else null. When scoring a candidate, `distanceKm =
   haversine(currentPos, plantCoords[ticket.plantId])` in JS; after an SE WINS a ticket at a new
   plant, advance their `currentPos` to that plant. Ticket order stays canonical (Q1) — distance
   shapes SE choice within tier (#266), never ticket order.
4. Null-honesty (Q5 alignment): missing SE home AND no prior stop, **or a plant whose `location` is
   NULL** → feature null → contribution 0 AND breakdown marks `distance: NOT_AVAILABLE` (#270's
   tri-state vocabulary, shared). **A missing coordinate must NEVER default to `(0,0)`** — that is
   a point in the Gulf of Guinea and would hand every such candidate a spectacular fake distance.
5. Fix the seeded-weight lie by making it true (weight stays 0.1, now fed) — no more
   `scoreDegenerate` admission at `:644`.
6. Admin: SE Directory inline-editing (#150 machinery) gains the two fields, MANAGER-editable under
   existing SE-edit RBAC; blank allowed.
7. NO mobile GPS reads, NO `last_activity` coordinates, NO tracking — Phase 1 boundary stated in
   code comment at the feature site.
8. **Distance and clustering must stay orthogonal.** #266's Q-A clustering prices *same-plant*
   continuation; this component prices *geographic* proximity. Neither may re-price the other, or
   the breakdown becomes uninterpretable and the same preference is counted twice.

## Existing code to reuse

`scoring.ts` distance component (already written, never fed); APPEND schedule lookup + `MAX(stop)`
plant; `plants.location`; #150 SE-directory editing; #266's per-candidate scoring loop.

## Data model

Two nullable columns on `engineer_master` (one migration). No index.

## API

`GET/PATCH` SE directory payloads gain `homeLat`/`homeLng` (additive; #169 contract-freeze check:
these are admin endpoints, not SE-mobile — verify freeze scope at implementation).

## UI surfaces

Admin: SE Directory row editor (two numeric fields). Mobile: n/a.

## Reference

`docs/ui/desktop/v2-reference/` SE directory page (no layout change beyond two fields).

## Acceptance criteria

- [ ] Same tier, equal other factors: nearer SE (by home base) wins the first assignment; after SE A
      wins a stop at plant P, a next ticket AT P prefers A through distance (chain advancement).
- [ ] SE with null home and no prior stop: distance NOT_AVAILABLE in breakdown, 0 contribution,
      never dropped for it (non-blocking).
- [ ] Distance never reorders tickets (canonical-order pin from #266 re-asserted).
- [ ] Haversine unit-tested against known city pairs (±1%).
- [ ] **Plant coordinates are fetched once per zone-run**, not per ticket/candidate (asserted by
      query count on a multi-ticket fixture — the regression that would otherwise creep in silently).
- [ ] **A plant with NULL `location` yields `NOT_AVAILABLE`**, contributes 0, and is never treated
      as `(0,0)` — pinned with a fixture plant that has no geometry.

## Tests

Unit: haversine + chain-advancement. e2e: `recommender-distance.e2e-spec.ts` with seeded geometry;
admin inline-edit spec.

## Dependencies / Blocked by

#266 (score must select before distance can matter).

## Risks

Data-entry dependence: until admins enter home bases, distance is uniformly NOT_AVAILABLE — correct
and visible, but operators should know entry unlocks it (runbook line). Plant geometry coverage on
the dev mirror should be measured, not assumed, at implementation.

## Rollback

Additive columns; weight already existed.
