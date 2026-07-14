# 119 — Plant deactivation semantics (FSM-owned flag + device/ticket effects)
Status: done (2026-07-14 — slices 1–4; commits 563c39d, 4ddf347, 09ec199 + slice-4 docs commit)
Type: schema + business design (HITL: business-rule decision)

> **Resolution (2026-07-14):** Built as a `plant_deactivations` side table (anti-drift, never in the
> master-sync update set; partial-unique one-active-row-per-plant). OH-only API
> `POST /api/plants/:plantId/deactivate|reactivate` + `GET /api/plants/deactivations`, admin page
> "Plant Deactivations". Deactivate cancels open tickets (`CLOSED` /
> `OPERATIONS_HEAD_OVERRIDE_CLOSE` / `PLANT_DEACTIVATED: <reason>`, FailureCycle → `FAILED`) in one
> audited tx; downstream exclusions in ticket-creation, dashboard counts, recommender dispatch, and
> the #121 export (`plant_fsm_status`). **Applied to the six STAR CEMENT plants** (3040, 3530, 3078,
> 3529, 3619, 3187) via the real API on the dev DB: 935 open tickets cancelled, UNZONED (zone 5)
> operational device count 4,607 → 3,620. Reasons record the disputed-claim caveat (AutoPlant still
> lists all six ACTIVE) — reversible via reactivate if the DB team overturns the shutdown report.

> Source: zone-application session 2026-07-13 (Phase 2C, deferred by design). Six STAR CEMENT
> plants are reported shut down (`docs/audits/shutdown-plants-2026-07-13.md`) but FSM has no
> deactivation mechanism: `plants.status` is the AutoPlant mirror and sits **in the master-sync
> update set** (`master-mapping.ts:228,239`) — any manual flip is stomped on the next sync. The six
> rows were left in the UNZONED holding zone.

## The gap

- No FSM-owned "deactivated/retired" flag on `plants` (schema `plants` model has zoneId/districtId
  as the only FSM-owned columns; everything else mirrors AutoPlant).
- Undefined semantics for a deactivated plant's devices, device_states, open tickets, SE coverage
  rows, and dashboard visibility.
- Master-sync scope (`plantStatuses: ACTIVE`) only affects *future* syncs — an already-synced plant
  stays forever.

## Caveat that must be resolved first (disputed claim)

`shutdown-plants-2026-07-13.md`: AutoPlant `mst_plant` still lists all six ids (3040/3530 with
ACTIVE+INACTIVE variants, 3078 ACTIVE-only) and they still carry vehicles in `mst_vehicle`
(771/640/545). Confirm with the DB team before designing against "shutdown" as a fact.

## Scope sketch (design first, HITL)

1. Decide the model: FSM-owned `opsStatus` enum on plants (insert-only + admin API, same anti-drift
   pattern as `zoneId`) vs. a `plant_deactivations` side table.
2. Define effects: exclude from recompute/ticket creation? auto-close open tickets? hide from ZM
   dashboards? keep history visible?
3. Admin surface + audit, then apply to the six STAR CEMENT rows.
