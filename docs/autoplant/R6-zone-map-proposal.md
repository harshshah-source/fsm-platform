# R6 — `plant_state → FSM zone` map proposal (for Ops-Head ratification)

> **Status:** PROPOSAL — values are derived from production `plant_state` data + AutoPlant's own
> `mst_region` grouping, **for Ops Head to confirm/correct**. Not an adopted rule.
> **Encoded (provisional):** `apps/backend/src/ingestion/autoplant/state-zone-map.ts` (`STATE_ZONE_MAP`)
> and the `StateMapZoneResolver` (`PlantZoneResolver`). The **breaking** `plants.zone_id → nullable`
> migration + `UNZONED` holding zone + exception-queue read remain **gated** until this is ratified.
> **Authorities:** blueprint §5.2 / R6; `zone-architecture-investigation.md` §Revision 3 (§5 Q6).

## Two decisions

### Decision 1 — the FSM operational zone *set* (BLOCKER)

The dev seed (`apps/backend/src/org/org-seed.ts:11`) defines only **`['North', 'South']`**. The
architecture (ADR-0018, one ZM per zone) implies the standard **four**: **NORTH / SOUTH / EAST / WEST**.
**Confirm the production zone set.** If four, the `EAST` and `WEST` zones (and their ZMs) must exist
before any plant maps to them — the resolver returns "defer" (null) for a zone name that isn't seeded.

### Decision 2 — the state → zone map

Cross-checked against AutoPlant's own `mst_region` grouping observed in the data
(Chandigarh/Delhi/J&K/Ladakh → North; Bihar/Jharkhand/Chhattisgarh/Odisha/Assam+NE → East):

| FSM Zone | States |
|---|---|
| **NORTH** | Delhi, Haryana, Punjab, Chandigarh, Himachal Pradesh, Jammu & Kashmir, Ladakh, Uttarakhand, **Uttar Pradesh**, **Rajasthan** |
| **SOUTH** | Andhra Pradesh, Telangana, Karnataka, Tamil Nadu, Kerala, Puducherry |
| **EAST** | West Bengal, Odisha, Jharkhand, Bihar, Assam, Arunachal Pradesh, Manipur, Meghalaya, Mizoram, Nagaland, Tripura, Sikkim, **Chhattisgarh** |
| **WEST** | Maharashtra, Gujarat, Goa, **Madhya Pradesh** |

States confirmed present in the plant sample: Andhra Pradesh, Karnataka, Tamil Nadu, Maharashtra,
Madhya Pradesh, Uttar Pradesh, West Bengal, Odisha, Jharkhand, Bihar, Chhattisgarh, Assam, Delhi.

## Ambiguities that need an explicit call (no clean 4-zone answer)

1. **Chhattisgarh** — standard geography → West/Central, but **AutoPlant's own data says East**.
   Encoded as **East** (follow AutoPlant) — confirm.
2. **Madhya Pradesh** — Central India; encoded **West**. Could be North. Confirm.
3. **Uttar Pradesh / Rajasthan** — encoded **North**; some ops models put them Central/West. Confirm.
4. There is **no "Central" zone** in a 4-zone model → MP/Chhattisgarh must land in one of the four
   (items 1–2).

## Unmappable / junk → UNZONED (never force-assigned)

Junk `plant_state` values seen in the data: **`india`**, **`NA`**, blank. These (and any state not in
the ratified map) → the **`UNZONED` holding zone** → **Ops-Head exception queue** for manual placement.
Where `mst_plant.zone_name` (AutoPlant's own directional zone) disagrees with the state-derived zone,
the plant is **flagged** (conflict) to the same queue rather than auto-overridden.

## Finalising query (my sample is partial — please run against production)

Gives the full distinct state set + AutoPlant's `zone_name` per state for cross-check (investigation §5 Q6):

```sql
SELECT plant_state, zone_name, COUNT(*) AS plants
FROM ap_masters.mst_plant
WHERE status = 'ACTIVE'
GROUP BY plant_state, zone_name
ORDER BY plants DESC;
```

## What gets built on ratification (the gated, breaking part)

1. `plants.zone_id → nullable` migration + the `UNZONED` holding zone + an Ops-Head exception-queue read.
2. Point `StateMapZoneResolver` at the ratified `STATE_ZONE_MAP` (values un-flagged).
3. Wire it as `PLANT_ZONE_RESOLVER`, register `MasterSyncService`, VPN dry-run.

The `~16 cross-zone / planner / override` call-site ripples of making `zone_id` nullable are why this
stays a deliberate, ratified migration rather than an AFK change.
