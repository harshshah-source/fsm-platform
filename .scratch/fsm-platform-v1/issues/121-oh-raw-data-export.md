# 121 — OH raw-data export page (entity-mapping CSV)
Status: done (2026-07-14, TDD) — backend endpoint + OH Exports page landed; one AC (fsm-status
'deactivated' row) is seam-deferred to [[119]] Task A.
Type: AFK

> Source: session 2026-07-14. Operations Head needs a raw, per-device reconciliation export of the
> whole org graph (zone application / shutdown review / offline analysis). Extends the existing CSV
> machinery (vouchers `StreamableFile` export; FE `lib/csv.ts`) rather than forking it.

## What to build

1. **Backend** — OH-only `GET /api/exports/entity-mapping` producing a CSV, one row per device:
   `device_id, vehicle_no, company, plant_name, source_plant_id, zone, zone_source
   (override/mapped/unzoned), transporter, deployment_status, plant_fsm_status (active/deactivated),
   latest_gps_datetime, inactive_hours, sla_bucket, eligible_for_uptime, open_ticket_count`.
   Keyset-batched over the ~19k-device population (no unbounded in-memory build); audited
   `EXPORT_DOWNLOADED`. Companion `GET /api/exports/entity-mapping/summary` → `{ rowCount, dataAsOf }`
   for the card hint.
2. **FE** — OH-nav-only "Exports" page: a card "Entity mapping (CSV)" with a download button +
   row-count/last-updated hint. Card grid leaves room for future exports.

## Acceptance criteria

- [x] `GET /api/exports/entity-mapping` returns text/csv, OH 200 / CSM·ZM·SE 403 (global-guard enforced).
- [x] CSV shape: canonical header + one fully-joined seeded device row (all 15 columns).
- [x] Query is keyset-batched (2000/page) — the whole fleet is never materialised in memory.
- [x] Each download is audited as `EXPORT_DOWNLOADED`.
- [x] FE: OH-only nav entry + `/exports` route (`RoleRoute OPERATIONS_HEAD`); card renders with the
      summary hint; download action auth-fetches the endpoint and triggers the browser download.
- [ ] A deactivated plant's devices show `plant_fsm_status = 'deactivated'` — **seam-deferred to
      [[119]] Task A**: the column exists and emits `'active'` for all until `plant_deactivations`
      lands, at which point the join + this test are added.

## Reference
Backend CSV pattern: `vouchers.controller.ts` (`StreamableFile`). FE download: `lib/csv.ts`.
Per-device query extended from `device.service.ts:listDevices`.

## Blocked by
None. Couples to [[119]] for the single fsm-status column (built behind a one-line seam).
