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

Because the counts come from one scan of one predicate set, they partition the scope exactly and
cannot drift:

```
mirrored     = operational + warehouse
operational  = healthy + inactive + neverReported     ← THREE states since #223
reporting    = healthy + inactive
```

**Amended 2026-08-09 (#223).** This section stated `operational = healthy + inactive` for a year, and
that two-state identity was **wrong** — not arithmetically, but as a model. `healthy` was defined as
the *negation* of `inactive`, and `is_inactive` cannot be true without a timestamp to compare against,
so a device that had **never reported a single GPS fix** was not inactive, and therefore counted
healthy. 913 devices fleet-wide, 892 of them confirmed at the source as fitted, deployed and never
having sent anything: **absence of evidence read as evidence of health.**

Both rates are now taken over `reporting`, not `operational` — see Fleet Health % below.

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
| **Definition** | Devices currently deployed in the field and tracked by FSM. **No longer the denominator for the dashboard rates** — since #223 that is `reportingOperational` (this count minus never-reported devices). |
| **Counts** | Mirrored devices whose deployment is live — no open `device_departures` row. |
| **Excludes** | Warehouse / departed devices; devices on a deactivated plant; devices with no plant fitment. |
| **Source** | `device_states.is_departed` (denormalised from `device_departures` by `DeviceStateService.recompute`) |
| **Refresh** | Master sync detects departures/restores; the 30-minute recompute mirrors them. |
| **Formula** | `COUNT(device_states WHERE is_departed = false)` |
| **Reconciles** | `Σ company = Σ zone = fleet KPI`; also `= healthy + inactive + neverReported` (#223) |
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
| **Definition** | Operational devices reporting normally — deployed, tracked, **has reported at least once**, and not inactive. |
| **Excludes** | Warehouse devices; inactive operational devices; **never-reported devices** (#223). |
| **Formula** | `COUNT(device_states WHERE is_departed = false AND latest_gps_datetime IS NOT NULL AND NOT (is_inactive = true AND sla_bucket IS NOT NULL))` |
| **Reconciles** | `healthy + inactive + neverReported = operational`, exactly, at every level. |

**Corrected 2026-08-09 (#223).** The paragraph that stood here said:

> *"Counted directly rather than subtracted, over the complement predicate on the same non-departed
> set — so the identity holds by construction rather than by arithmetic that could be applied
> inconsistently."*

That reasoning is sound and the conclusion was still wrong, which is the useful part. **Holding "by
construction" is exactly what made the third state unrepresentable:** engineering `healthy` as the
literal complement of `inactive` guarantees the two sum to the whole, so any device that fails to be
inactive *must* be counted healthy, whatever the reason. A device that has never reported fails to be
inactive because it has no timestamp — a data-absence, not a health signal — and the construction had
no way to say so. The same document defined healthy in prose as *"operational devices reporting
normally"*; the SQL said "not inactive"; nothing compared the two for a year.

The identity is now three-way and `neverReported` is measured **independently** rather than as anyone's
complement, so it is a check that can actually fail. See [#228](../.scratch/fsm-platform-v1/issues/228-guard-pattern-remediation.md)
on tautological guards.

---

### Never-Reported Devices — *operational*

| | |
|---|---|
| **Definition** | Operational devices that have never sent a single GPS fix since being fitted. |
| **Excludes** | Warehouse devices. |
| **Formula** | `COUNT(device_states WHERE is_departed = false AND latest_gps_datetime IS NULL)` |
| **Reconciles** | `healthy + inactive + neverReported = operational`, at every level. |
| **Live value** | **913** pan-India (Vasavadatta 545, Deepak Fertilizer 208) |

Reported **beside** Fleet Health, not inside it — operator decision P4, 2026-08-09: *"different root
causes, different owners; 602 year-old devices would make the genuine backlog unreadable."* "Never
worked" is an installation-quality failure (the installer, the vendor, the commissioning process);
"stopped working" is a device failure (the field SE). Merging them hides which of the two is degrading.

Derived at read time from `latest_gps_datetime IS NULL` rather than stored as a column, because
`latest_gps_datetime` is maintained at **ingest** while a stored flag would be written by the
**recompute** — between the two, a stored flag would still say "never reported" about a device that
just came alive.

A never-reported device is **also** `is_inactive` once it has been fitted longer than the grace window
(operator decision P1: a fitted tracker that has never reported is a fault, ticketed like any other
silent device), which is why `inactiveOperational` is narrowed to reporting devices — otherwise such a
device would be counted twice and the identity would overshoot.

---

### Inactive % — *derived*

| | |
|---|---|
| **Formula** | `inactiveOperational ÷ reportingOperational × 100`, one decimal |
| **Excludes** | Warehouse devices **and never-reported devices**, from **both** numerator and denominator. |
| **Null case** | `—`, never `0.0%`, when the entity has nothing that has reported — "nothing to measure" is not "nothing wrong". |
| **Reconciles** | `Inactive % + Fleet Health % = 100%` for every row. |

### Fleet Health % — *derived*

| | |
|---|---|
| **Formula** | `healthyOperational ÷ reportingOperational × 100`, one decimal |

**The denominator changed 2026-08-09 (#223 P3).** It was `operationalDevices`. Never-reported devices
are **excluded** from Fleet Health rather than scored 0% — operator decision, with the alternative
(score them zero, keep them in the denominator) explicitly considered: excluding *"keeps the KPI
measuring what it claims: reliability of devices that have reported"*, with the never-reported count
shown beside it.

**Expect a step change on the fix day.** Pan-India, Fleet Health moves **82.96% → 84.84%** once #223
lands together with [#222](../.scratch/fsm-platform-v1/issues/222-telemetry-staleness.md). The two
defects were partly cancelling — NDD inflated the figure by ~1.06 points and #222's 5.5 h timestamp
shift deflated it by ~2.76 — so the net error looked like only ~1.9 points while the gross error was
~3.9 and unstable. That is why the two shipped as one slice: #223 alone moves the number *down* to
81.90% and reads as a regression caused by a bug fix.

`soft_inactive_count_history` holds denominators snapshotted under the old definition, so trend charts
show a discontinuity on the fix day. **Expected and correct, not a regression.**

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
confirmed Non-Operational marking), warehouse devices, and — since #223 — **never-reported devices**.
`—` until a monthly run has been computed.

**Why never-reported devices had to be excluded (#223 P3).** Uptime is computed as failure-cycle
overlap over the month. A failure cycle is opened from inactivity, and inactivity requires a timestamp
— so a device that has never reported had never opened a cycle and contributed **a full month of zero
downtime**, scoring **100%**. The single most broken device in the fleet was scored as the healthiest
possible device, for 913 devices, 545 of them at one customer. This was the most consequential of the
six read surfaces the defect reached and neither of the two independent reports that found #223 caught
it.

The exclusion is applied in the uptime aggregation, **not** by clearing `eligible_for_uptime` — that
flag is also the ticket-creation gate, and clearing it would silently stop the never-reported devices
from ever being ticketed, cancelling the decision (P1) that this issue exists to implement.

---

## 4. Fleet Composition — the funnel

`GET /api/dashboard/fleet-composition`. Every reduction between two populations is named and counted,
so the catalog→operational gap has no unexplained losses.

| Step | Live value | What drops next, and why |
|---|---:|---|
| AutoPlant Catalog | 50,270 | **− 26,045 not mirrored** — non-operational at source and never known to FSM (read and counted, deliberately not created: the insert-scope pin in `master-sync.service.ts`) |
| Mirrored into FSM | 24,225 | **− 987 on deactivated plants** — Issue 119; listed under Plant Deactivations |
| On live plants | 23,238 | splits into operational + warehouse |
| ├ Operational Devices | 17,415 | splits into healthy + inactive + **never-reported** (#223) |
| │  ├ Healthy Devices | 13,939 | |
| │  ├ Inactive Devices | 3,476 | |
| │  └ **Never-Reported Devices** | — | **new third branch (#223)** — rendered as a two-way split, the funnel no longer sums |
| └ Warehouse Devices | 5,823 | reconciles separately |

*(The live values in this table predate #223 and #222. Fleet-wide as measured 2026-08-09: operational
15,696 · healthy 13,021 · inactive 2,675 · never-reported 913 — and after both fixes, reporting 14,783
with healthy 12,542, i.e. Fleet Health 84.84%.)*

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
  healthyOperational + inactiveOperational + neverReported = operationalDevices   ← #223
  healthyOperational + inactiveOperational                 = reportingOperational
  operationalDevices + warehouseDevices                    = mirroredDevices
  Σ byBucket                                                = inactiveOperational
  inactivePct + fleetHealthPct                              = 100%   (when reportingOperational > 0)

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
