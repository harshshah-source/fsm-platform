# Dashboard KPI definitions

**Status:** current · **Owner:** Admin dashboard · **Last verified against the live dev DB:** 2026-07-29

Every number the admin dashboard shows, with its business definition, its exact query, what it
excludes, and the identity it reconciles into. The same content ships in-product as the info tooltip
on each KPI card and column header — `apps/admin/src/lib/kpiCatalog.ts` is the single source of truth,
and this document restates it with the SQL.

Backing code:

| Layer | File |
|---|---|
| Aggregate + endpoints | `apps/backend/src/dashboard/dashboard.service.ts`, `dashboard.controller.ts` |
| Tooltip catalog | `apps/admin/src/lib/kpiCatalog.ts` |
| Reconciliation tests | `apps/backend/test/dashboard-kpi-reconciliation.e2e-spec.ts` |
| UI transparency tests | `apps/admin/test/kpi-transparency.test.tsx` |

---

## 1. The two families

Every figure belongs to exactly one family, and the two are never mixed in one piece of arithmetic.

| Family | Means | Examples |
|---|---|---|
| **Source** | What AutoPlant reports, as of its last sync. Another system's inventory, at another moment. | AutoPlant Catalog |
| **Operational** | What FSM tracks in `device_states` right now. | Operational / Warehouse / Inactive / Healthy Devices |
| **Derived** | A ratio of two operational counts. | Inactive %, Fleet Health % |

The defect this rework fixed was precisely a family mix-up: an operational numerator over a
denominator that silently included warehouse devices.

---

## 2. The shared aggregate

Every operational count at every level — fleet, zone, company×plant, company, plant — is selected by
one SQL fragment, `FLEET_COUNT_COLUMNS` (`dashboard.service.ts`). Only the `GROUP BY` differs.

```sql
COUNT(*)::int AS "mirroredDevices",
COUNT(*) FILTER (WHERE ds.is_departed = false)::int AS "operationalDevices",
COUNT(*) FILTER (WHERE ds.is_departed = true)::int  AS "warehouseDevices",
COUNT(*) FILTER (WHERE ds.is_departed = false
                   AND ds.is_inactive = true
                   AND ds.sla_bucket IS NOT NULL)::int AS "inactiveOperational",
COUNT(*) FILTER (WHERE ds.is_departed = false
                   AND NOT (ds.is_inactive = true
                            AND ds.sla_bucket IS NOT NULL))::int AS "healthyOperational"
```

over

```sql
FROM device_states ds
JOIN plants p ON p.plant_id = ds.plant_id
[JOIN zones z ON z.zone_id = p.zone_id]          -- zone / company / plant levels
WHERE true <zone scope>
  AND p.plant_id NOT IN (SELECT plant_id FROM plant_deactivations WHERE reactivated_at IS NULL)
```

Because the five counts come from one scan of one predicate set, they partition the scope exactly and
cannot drift:

```
mirrored     = operational + warehouse
operational  = healthy + inactive
```

**Scope filters applied at every level:**

- **Deactivated plants excluded** (`EXCLUDE_DEACTIVATED_PLANTS`, Issue 119) — those devices are
  surfaced on the OH "Plant Deactivations" list instead.
- **Zone scoping** — a `ZONAL_MANAGER` is clamped to their own zone; `CENTRAL_SERVICE_MANAGER` and
  `OPERATIONS_HEAD` see every zone.
- **`JOIN plants`** is inner, so a `device_states` row with no plant fitment is out of scope
  everywhere (currently 0 rows).

---

## 3. KPI reference

### AutoPlant Catalog — *source*

| | |
|---|---|
| **Definition** | Total unique devices discovered in AutoPlant during the latest successful master sync. Includes deployed, warehouse, retired, and other non-operational devices. |
| **Counts** | Every distinct fitted `device_id` the master-sync source read returned, all deployment statuses, pan-India. |
| **Excludes** | Nothing — this is the unfiltered source catalog. |
| **Source** | `master_sync_runs.entity_stats → devices.observed` (latest `SUCCESS` run) |
| **Refresh** | Daily master sync, or a manual "Run Ingestion Now". Rendered with its sync timestamp. |
| **Live value** | **50,270** (run 90, finished 2026-07-29 05:49 UTC) |

```sql
SELECT (entity_stats -> 'devices' ->> 'observed')::int
FROM master_sync_runs
WHERE status = 'SUCCESS' AND entity_stats -> 'devices' ->> 'observed' IS NOT NULL
ORDER BY finished_at DESC NULLS LAST LIMIT 1;
```

> **Not zone-attributable.** AutoPlant does not report an FSM zone, so this is pan-India only and is
> `null` for a zone-scoped caller. Never use it as a denominator for an FSM rate.

The counter is written at sync time in `master-sync.service.ts`:

```ts
const sourceDeviceIds = new Set<string>();
for (const v of vehicleMasters) {
  const id = String(v.device_id ?? '').trim();
  if (id !== '') sourceDeviceIds.add(id);
}
stats.devices.observed = sourceDeviceIds.size;
```

---

### Mirrored Devices — *operational*

| | |
|---|---|
| **Definition** | Every device FSM holds a record for at this entity — operational plus warehouse. |
| **Excludes** | Devices on a deactivated plant; devices with no plant fitment. |
| **Source** | `device_states` joined to `plants` |
| **Formula** | `COUNT(device_states)` |
| **Reconciles** | `mirrored = operational + warehouse` |
| **Live value** | **23,238** pan-India |

---

### Operational Devices — *operational*

| | |
|---|---|
| **Definition** | Devices currently deployed in the field and tracked by FSM. **The denominator for every rate on the dashboard.** |
| **Counts** | Mirrored devices whose deployment is live — no open `device_departures` row. |
| **Excludes** | Warehouse / departed devices; devices on a deactivated plant; devices with no plant fitment. |
| **Source** | `device_states.is_departed` (denormalised from `device_departures` by `DeviceStateService.recompute`) |
| **Refresh** | Master sync detects departures/restores; the 30-minute recompute mirrors them. |
| **Formula** | `COUNT(device_states WHERE is_departed = false)` |
| **Reconciles** | `Σ company = Σ zone = fleet KPI`; also `= healthy + inactive` |
| **Live value** | **17,415** pan-India |

---

### Warehouse Devices — *operational*

| | |
|---|---|
| **Definition** | Devices removed from field operations and held in a warehouse. Not broken — not counted against anyone. |
| **Excludes** | Operational devices. Warehouse devices are excluded from inactivity, SLA bucketing and uptime eligibility **by design** — a warehoused device must not age through the SLA bands. |
| **Source** | `device_states.is_departed = true` |
| **Formula** | `COUNT(device_states WHERE is_departed = true)` |
| **Reconciles** | Separately from the operational fleet: `operational + warehouse = mirrored`. Never appears in a rate. |
| **Live value** | **5,823** pan-India |

---

### Inactive Operational Devices — *operational*

| | |
|---|---|
| **Definition** | Operational devices that have gone silent longer than the inactivity threshold and are therefore in an SLA band. |
| **Excludes** | Warehouse devices (a departed device is never counted inactive); devices in the 0–4h ACTIVE band; deactivated plants. |
| **Source** | `device_states.is_inactive` + `sla_bucket` |
| **Refresh** | 30-minute telemetry tick — ages advance with wall-clock time, not only on new pings. |
| **Formula** | `COUNT(device_states WHERE is_departed = false AND is_inactive = true AND sla_bucket IS NOT NULL)` |
| **Reconciles** | `Σ company = Σ zone = fleet KPI`; also equals the sum of the per-SLA-bucket columns on the same row. |
| **Live value** | **3,476** pan-India |

> The departed exclusion is structural, not a filter this query adds: `DeviceStateService.recompute`
> sets `is_inactive = (NOT departed AND hours >= threshold)` and nulls `sla_bucket` for departed
> devices. Verified live: 0 rows are both departed and inactive.

---

### Healthy Operational Devices — *operational*

| | |
|---|---|
| **Definition** | Operational devices reporting normally — deployed, tracked, and not inactive. |
| **Excludes** | Warehouse devices; inactive operational devices. |
| **Formula** | `COUNT(device_states WHERE is_departed = false AND NOT (is_inactive = true AND sla_bucket IS NOT NULL))` |
| **Reconciles** | `healthy + inactive = operational`, exactly, at every level. |
| **Live value** | **13,939** pan-India |

Counted directly rather than subtracted, over the complement predicate on the same non-departed set —
so the identity holds by construction rather than by arithmetic that could be applied inconsistently.

---

### Inactive % — *derived*

| | |
|---|---|
| **Formula** | `inactiveOperational ÷ operationalDevices × 100`, one decimal |
| **Excludes** | Warehouse devices, from **both** numerator and denominator. |
| **Null case** | `—`, never `0.0%`, when the entity has no operational devices — "nothing to measure" is not "nothing wrong". |
| **Reconciles** | `Inactive % + Fleet Health % = 100%` for every row. |

### Fleet Health % — *derived*

| | |
|---|---|
| **Formula** | `healthyOperational ÷ operationalDevices × 100`, one decimal |

---

### Critical Devices — *operational*

Strictly the CRITICAL band (24–48h), per the Issue 122 operator decision — **not** a "critical and
above" superset. Worse bands appear in the Zone Overview and the SLA distribution.
Formula: `Σ zone.byBucket['CRITICAL']`.

### Companies / Plants — *operational*

`COUNT(DISTINCT device_states.company_id)` / `COUNT(DISTINCT device_states.plant_id)` in scope. The
companies figure equals the Fleet Directory companies row count. Live: **30** companies, **215** plants.

### Last Snapshot / Last Activity — *operational*

| | |
|---|---|
| **Last Snapshot** | `MAX(device_states.computed_at)` — when FSM last re-derived the rows. Fleet-wide, `snapshot_runs.finished_at` of the latest `SUCCESS` run. |
| **Last Activity** | `MAX(device_states.latest_gps_datetime)` — when the entity's fleet last reported from the field. |

Not the same thing: FSM keeps recomputing long after a device stops pinging. Both are shown so
"0 inactive" can be told apart from a stalled snapshot.

### Fleet Uptime — *derived, external*

Share of eligible device-time spent reporting this month, from the Fleet Uptime monthly report
(`/api/reports/fleet-uptime`). Excludes devices not eligible for uptime (no active PGI in window, or a
confirmed Non-Operational marking) and warehouse devices. `—` until a monthly run has been computed.

---

## 4. Fleet Composition — the funnel

`GET /api/dashboard/fleet-composition`. Every reduction between two populations is named and counted,
so the catalog→operational gap has no unexplained losses.

| Step | Live value | What drops next, and why |
|---|---:|---|
| AutoPlant Catalog | 50,270 | **− 26,045 not mirrored** — non-operational at source and never known to FSM (read and counted, deliberately not created: the insert-scope pin in `master-sync.service.ts`) |
| Mirrored into FSM | 24,225 | **− 987 on deactivated plants** — Issue 119; listed under Plant Deactivations |
| On live plants | 23,238 | splits into operational + warehouse |
| ├ Operational Devices | 17,415 | splits into healthy + inactive |
| │  ├ Healthy Devices | 13,939 | |
| │  └ Inactive Devices | 3,476 | |
| └ Warehouse Devices | 5,823 | reconciles separately |

A zone-scoped caller (a ZM) gets `catalogDevices: null` and `notMirrored: null`, and their funnel
starts at "Mirrored into FSM" — opening a zone funnel with a pan-India source counter would repeat the
category error this rework removed.

---

## 5. The reconciliation identities

These hold at every level and are enforced by
`apps/backend/test/dashboard-kpi-reconciliation.e2e-spec.ts` over the whole database, not just a
fixture.

```
Σ company×plant.operationalDevices  = Σ zone.operationalDevices  = fleetSummary.operationalDevices
Σ company×plant.inactiveOperational = Σ zone.inactiveOperational = fleetSummary.inactiveOperational
Σ company×plant.warehouseDevices    = Σ zone.warehouseDevices    = fleetSummary.warehouseDevices
Σ fleetDirectory.companies[*]       = Σ fleetDirectory.plants[*] = fleetSummary            (all counts)

For every row, at every level:
  healthyOperational + inactiveOperational = operationalDevices
  operationalDevices + warehouseDevices    = mirroredDevices
  Σ byBucket                                = inactiveOperational
  inactivePct + fleetHealthPct              = 100%   (when operationalDevices > 0)

Composition:
  mirroredTotal − onDeactivatedPlants = mirroredDevices
  catalogDevices − notMirrored         = mirroredTotal
```

**Live verification, 2026-07-29** (pan-India, dev DB, master sync run 90) — all 14 checks pass:

| Identity | Value |
|---|---|
| Σ zone operational == fleet operational | 17,415 |
| Σ zone inactive == fleet inactive | 3,476 |
| Σ zone warehouse == fleet warehouse | 5,823 |
| Σ zone healthy == fleet healthy | 13,939 |
| Σ company×plant operational == fleet | 17,415 |
| Directory companies Σ operational == fleet | 17,415 |
| Directory plants Σ operational == fleet | 17,415 |
| healthy + inactive == operational | 17,415 |
| operational + warehouse == mirrored | 23,238 |
| Σ byBucket == fleet inactive | 3,476 |

Per zone:

| Zone | Operational | Inactive | Healthy | Warehouse | Inactive % | Fleet Health % |
|---|---:|---:|---:|---:|---:|---:|
| North | 3,527 | 400 | 3,127 | 1,088 | 11.3% | 88.7% |
| South | 2,482 | 874 | 1,608 | 1,611 | 35.2% | 64.8% |
| East | 6,529 | 810 | 5,719 | 1,637 | 12.4% | 87.6% |
| West | 2,098 | 347 | 1,751 | 363 | 16.5% | 83.5% |
| UNZONED | 2,779 | 1,045 | 1,734 | 1,124 | 37.6% | 62.4% |
| **Total** | **17,415** | **3,476** | **13,939** | **5,823** | | |

---

## 6. What changed on 2026-07-29, and why

**The defect.** `zoneOverview`'s denominator counted every mirrored device, while its numerator — and
the "Active Fleet" KPI — counted only non-departed ones. `inactive / total` therefore divided an
operational numerator by an operational + warehouse denominator. The same omission was in
`companyPlantOverview` and in `fleetDirectory`, whose docstring claimed reconciliation with the KPI
strip that it never had (23,238 vs 17,415).

**Why it mattered.** Warehouse stock is not evenly distributed — West is 14.7% departed, South 39.4% —
so the distortion was uneven and re-ordered the Zone Performance Scorecard, which is a league table:

| Zone | Shown before | Actual | Understated by |
|---|---:|---:|---:|
| South | 21.4% | 35.2% | 1.65× |
| UNZONED | 26.8% | 37.6% | 1.40× |
| North | 8.7% | 11.3% | 1.31× |
| East | 9.9% | 12.4% | 1.25× |
| West | 14.1% | 16.5% | 1.17× |

**The fixes.**

1. **One aggregate.** All five counts now come from a single shared SQL fragment at every level, so a
   numerator and a denominator cannot be computed by two statements that disagree.
2. **Rows driven by the population, not by the problem.** Zone and company×plant rows were previously
   built from the *inactive* query, so an entity with a fleet but zero inactive devices vanished —
   taking its operational devices out of the column totals. Rows now come from the counts query
   (company×plant rows: 135 → 205 live). A healthy entity renders `0 / N`.
3. **Explicit names.** "Total Devices" → **AutoPlant Catalog** (with its sync timestamp on the card);
   "Active Fleet" → **Operational Fleet**; "Inactive / Total" → **Inactive Operational**.
4. **Warehouse surfaced.** Previously invisible — the 5,823 devices were inside a denominator and
   named nowhere. Now its own KPI and its own column, outside every rate.
5. **Tooltips everywhere.** Every KPI card and counted column header carries its definition,
   exclusions, source, refresh trigger and formula, from `lib/kpiCatalog.ts`.

**Business logic unchanged.** The definition of "inactive" is byte-for-byte what it was
(`is_inactive AND sla_bucket IS NOT NULL`); the inactivity threshold, the SLA bands, the departure
semantics and the deactivated-plant exclusion are all untouched. Only denominators, row construction,
naming and presentation changed.

---

## 7. Known limitation

**AutoPlant Catalog is not attributable per company or plant.** The source read's non-mirrored rows
are never persisted with their plant, so only the pan-India total exists. The Fleet Directory
therefore reports **Mirrored Devices** (operational + warehouse — what FSM actually holds) per entity,
which reconciles exactly, rather than a per-entity catalog figure that does not exist. Recording
per-plant observed counts at sync time would need an ingestion change and a migration, and would
back-fill nothing; it is not in this rework.
