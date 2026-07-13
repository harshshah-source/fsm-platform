# 120 — Zone-mapping admin UI (pending queue + overrides page)
Status: needs-triage
Type: admin web feature (backend complete)

> Source: zone-application session 2026-07-13 (Phase 1 finding). The entire R6 zone-mapping admin
> surface is API-only: `apps/admin` has zero references to `/api/org/zone-mappings` or
> `/api/org/plant-zone-overrides`. The 2026-07-13 application had to drive the API with a script;
> an Ops Head cannot operate the queue (B8 zone ratification) from the dashboard at all.

## Backend already there (no changes needed)

- `GET /api/org/zone-mappings[?status=]`, `/pending`, `POST /:id/map`, `POST /:id/ignore`
- `GET/PUT/DELETE /api/org/plant-zone-overrides`
- `POST /api/org/zone-mappings/reapply` (returns plantsConsidered/updated/landedUnzoned)
- All OPERATIONS_HEAD-guarded and audited (`zone-mapping.controller.ts`).

## Scope

1. Admin page: PENDING-values work queue (busiest first, seenCount/lastSeenAt), map-to-zone /
   ignore actions; mapped/ignored tabs.
2. Plant-overrides table: list/upsert/delete with the `reason` field surfaced (it carries sub-zone
   + provenance tags from the 2026-07-13 batch — display, don't truncate).
3. A visible "Re-apply" action with its result summary, plus the standing UNZONED plant/device
   counts so Ops can see the effect.
4. Follow the surfacing rule: check `docs/ui/desktop/v2-reference/` for the authoritative layout
   before building; role-gate to Operations Head.
