# Shutdown Plants — 2026-07-13

> All six are STAR CEMENT sites, reported shut down / decommissioned. Their rows in
> unzoned-plants-2026-07-07.md carry a `SHUTDOWN [...]` marker and they are excluded from the
> v2UnzonnedPlants.md worklist. Claim source per row: 'DB team CSV' =
> UnzonneedPlantList_autoplantDB.csv; 'user-confirmed' = company-wide shutdown confirmed in
> session on 2026-07-13. No zone lookup needed unless this is walked back.

| source_plant_id | Plant (FSM id) | Vehicles (audit) | Claim source | CSV variant rows | AutoPlant status (2026-07-13 query) | veh in mst_vehicle |
|---|---|---|---|---|---|---|
| 3040 | JORHAT CPW-SCL-LUMS (7) | 280 | DB team CSV | 95 | ACTIVE||INACTIVE | 771 |
| 3530 | BARPETA ROAD CRS-SCNEL (102) | 341 | DB team CSV | 64 | ACTIVE||INACTIVE | 640 |
| 3078 | PURNEA CPW SCL SGU (9) | 207 | DB team CSV | 41 | ACTIVE | 545 |
| 3529 | PANDU PORT CPS SCL-GGU (101) | 135 | user-confirmed | — | ACTIVE||INACTIVE | 382 |
| 3619 | SCNEL SILCHAR CEMENT (128) | 24 | user-confirmed | — | ACTIVE | 62 |
| 3187 | StarCement - LUMS (27) | 0 | user-confirmed | — | ACTIVE | 0 |

**Caveat (unresolved):** AutoPlant `mst_plant` still lists all six ids (statuses above; 3078
ACTIVE-only) and several still carry vehicles in `mst_vehicle`. The shutdown claims come from
the DB team CSV and an in-session confirmation — not from AutoPlant state. Confirm with the DB
team before treating these as permanently closed. Note 3628 (GGU, UTCL) shares the DB team's
'GGU' family with 3529/3530 but is NOT marked shutdown — it is a different company's plant.

**Update 2026-07-14 (#119 applied):** all six were deactivated in FSM via the OH
plant-deactivation API (`plant_deactivations` side table — 935 open tickets cancelled, UNZONED
operational device count 4,607 → 3,620). Each deactivation reason records the caveat above.
This is **reversible**: if the DB team walks the shutdown claim back, reactivate via
`POST /api/plants/:plantId/reactivate` (or the OH Plant Deactivations page) and the pipeline
re-creates tickets for still-inactive devices on the next run.
