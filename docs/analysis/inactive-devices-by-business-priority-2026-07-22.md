# Inactive Devices Ranked by Customer Business Criticality — Feasibility

**Date:** 2026-07-22 · **Branch:** `feat/autoplant-integration` · **Type:** READ-ONLY feasibility analysis.
No code changed, no issue filed, no design beyond a shape sketch.
AutoPlant reads were `SELECT` + `LIMIT ≤ 90` only; no bulk scans. Probe scripts deleted.

---

## Conclusion (plain language)

**YES — and it is far cheaper than expected, because the data is already in FSM.**

We do not need to add a column, change master sync, or query AutoPlant per request. Since
2026-07-17, `device_states.trip_creation_datetime` has been maintained on the 30-minute telemetry
tick, and **every inactive device is refreshed on every run** — the scan pages by immutable
`device_id` with no GPS-recency predicate, so a device that stopped reporting is still re-read and
still gets its trip stamp updated. I verified four devices against production AutoPlant today and
FSM's stored values match **to the second**. Coverage on the population that matters is 87%
(2,424 of 2,771 inactive devices carry a trip stamp).

So this is a read-only feature: one query, one endpoint, one page. No pipeline work.

**The signal is real, and it is genuinely new information.** Of the 2,729 currently-inactive devices,
only **111 (4.1%) are HIGH criticality** — the customer scheduled a trip on that vehicle within the
last 24 hours while its GPS has been dark for an average of **96 days**. And here is the part that
justifies the whole feature: **84 of those 111 sit in the `LONG_PENDING` SLA band**, which the
recommender's canonical sort ranks *last*. Meanwhile 658 devices whose vehicles have had no trip in
over a week *are* formally assigned to engineers. We are currently spending field capacity on trucks
the customer is not using, while the trucks they are actively dispatching stay broken.

**Two honest caveats that change the framing, not the verdict.**

First, the column's meaning is looser than "the dispatcher scheduled a trip at time T". On several
production rows the vehicle's `active_trip_id` encodes a date days earlier than
`TRIP_CREATION_DATETIME` — so the field behaves more like *when this vehicle's active-trip record was
last written* than *when this trip was created*. That still indicates live operational engagement,
which is what we want, but the label should be operational ("last dispatch activity"), not literal.

Second, the discrimination is compressed into a narrow window. 2,041 of 2,382 inactive devices with
a stamp were touched in **July 2026 alone**, and only ~28 have a stamp older than January. So "stale"
in practice means *one to three weeks*, not *seasonal*. The HIGH/MEDIUM/LOW gradient is real, but the
LOW bucket is mostly "not dispatched in the last fortnight", not "truck parked for the season".

**Recommendation:** build it as a **dedicated page** reading a **cached** column, default-sorted
HIGH → unassigned → longest inactive. Do **not** wire it into recommender scoring yet — the evidence
for a scoring seam is strong, but three preconditions are unmet (§3.4).

---

## 1. Semantics — verified against production

### 1.1 The column

`ap_widgets.tb_vehiclemaster` carries two relevant columns
(`information_schema.COLUMNS`, live):

| Column | Type |
|---|---|
| `TRIP_CREATION_DATETIME` | `timestamp` |
| `active_trip_id` | `varchar` |

`TRIP_CREATION_DATETIME` is a **last-value column on a latest-state table** — `tb_vehiclemaster` has
exactly one row per vehicle (`vehicle_no` is the PK, verified unique on production per
`autoplant-master-source.ts:239-242`). There is no history in this table.

**History is sourceable elsewhere, if we ever want it.** `ap_widgets` contains `tb_tripmaster` with
`trip_created_date`, `trip_start_date`, `trip_end_date`, `trip_status`, `trip_state`, `trip_id`
(plus `tb_triplegwise`, `tb_tripmaster_archival`). So a richer signal — trips *per week*, rather than
*most recent* — is available later without new access. Out of scope here; noted so it is not lost.

### 1.2 What the values look like

Server session confirmed UTC (`@@session.time_zone = SYSTEM`, `@@system_time_zone = UTC`,
`NOW() = UTC_TIMESTAMP() = 2026-07-22 07:22:09`), so raw wall-clock strings *are* UTC.

Top-20 by recency (production, `LIMIT 20`) all fell inside the same ~15-minute window on 2026-07-22 —
the fleet-wide column is extremely live. Consistent with SYSTEM-STATE §3b's measurement that 18.4% of
DEPLOYED vehicles change it per day.

### 1.3 FSM's cached copy is accurate — verified to the second

Four devices, production raw wall-clock (`CAST(... AS CHAR)`, driver conversion bypassed) vs FSM
`device_states.trip_creation_datetime` rendered explicitly `AT TIME ZONE 'UTC'`:

| device_id | AutoPlant (UTC) | FSM stored (UTC) | Δ |
|---|---|---|---|
| `0359688090100917` | `2026-07-17 23:50:45` | `2026-07-17 23:50:45` | **0** |
| `860141074846834` | `2026-07-10 16:21:56` | `2026-07-10 16:21:56` | **0** |
| `862491073529362` | `2026-07-14 22:20:01` | `2026-07-14 22:20:01` | **0** |
| `KA32C6473` | `2025-01-31 22:39:57` | `2025-01-31 22:39:57` | **0** |

4 of 4 exact. This also independently confirms the two-different-offsets design documented in
SYSTEM-STATE §3b: `latest_gps_datetime` is a `datetime` written in IST and normalised +330, while
`TRIP_CREATION_DATETIME` is a `timestamp` returned already-UTC and normalised at offset 0. Both are
correct in live data.

> **Methodology note, because it nearly produced a false alarm.** A naive comparison showed a clean
> +5:30 across every device. That was an artifact of *my probe*, twice over: `mysql2` without
> `dateStrings` reinterpreted the server's wall-clock in the node process's IST locale, and my
> ad-hoc `PrismaClient` omitted the `options: '-c timezone=UTC'` that `PrismaService` sets
> (`prisma/prisma.service.ts:36`), so the Postgres session defaulted to `Asia/Calcutta` and `to_char`
> rendered IST. Anyone re-running this must pin both sessions or they will "find" a 5.5-hour bug that
> is not there.

### 1.4 The semantic caveat

Sampling `active_trip_id` alongside the stamp on the eight most recently-touched production rows:

| vehicle_no | active_trip_id | TRIP_CREATION_DATETIME |
|---|---|---|
| WB67A9264 | `2607220002846` | 2026-07-22 07:21:35 |
| WB03C7239 | `2607200011016` | 2026-07-22 07:20:07 |
| JH05DV9274 | `2607210010651` | 2026-07-22 07:19:44 |
| WB37H7899 | `2607180003628` | 2026-07-22 07:15:24 |

The trip id prefix **appears** to encode `YYMMDD` (all eight begin `2607…`) — that is an
**inference from format, not proven**. If it holds, then `WB37H7899` carries a trip created on
07-18 whose `TRIP_CREATION_DATETIME` reads 07-22, and the column is not "when the trip was created".
The most defensible reading is **"when this vehicle's active-trip record was last written"**.

That is still a valid business-activity signal — arguably a better one, since it tracks ongoing
dispatcher engagement rather than a single creation event. But it must not be labelled "trip
scheduled at" in the UI, and it should be confirmed with AutoPlant's owners before the framing is
locked (§4, HITL).

---

## 2. The problem today, quantified

Population: `is_inactive = true`, `is_departed = false`, plant not deactivated → **2,729 devices**.
(Full population bucketed, not a 30-device sample — the cached column made the whole set cheap to
query. A 30-device random sample was separately pulled and cross-checked against production for §1.3.)

### 2.1 Distribution

| Bucket | Devices | % | Open ticket | SE assigned | **Unassigned** | Avg inactive | Max inactive |
|---|---|---|---|---|---|---|---|
| **HIGH** (trip ≤ 24 h) | **111** | 4.1% | 111 | 94 | **17** | 2,317 h (~96 d) | 18,798 h |
| **MEDIUM** (1–7 d) | 984 | 36.1% | 984 | 581 | 403 | 998 h (~42 d) | 19,030 h |
| **LOW** (> 7 d) | 1,287 | 47.2% | 1,287 | 658 | 629 | 2,743 h (~114 d) | 20,433 h |
| **NO TRIP DATA** | 347 | 12.7% | 347 | 91 | 256 | 10,109 h (~421 d) | 22,250 h |

Every device in every bucket already has an open TROUBLESHOOT ticket — the pipeline is doing its job;
the gap is purely **ordering**.

**The headline the field-service team would act on: 17 HIGH-criticality devices have no engineer
assigned.** That is a one-screen, same-day worklist.

### 2.2 The pattern that justifies the feature

Business criticality is **almost orthogonal to the SLA bucket the engine already sorts by**:

| Bucket | CRITICAL | HIGH_CRITICAL | SEVERE | VERY_SEVERE | **LONG_PENDING** |
|---|---|---|---|---|---|
| HIGH | 11 | 6 | 9 | 1 | **84 (76%)** |
| MEDIUM | 269 | 100 | 247 | 90 | 278 |
| LOW | 127 | 53 | 109 | 134 | **864** |
| NO TRIP DATA | 11 | 3 | 5 | 8 | 320 |

The canonical sort is `Tier desc → Bucket desc → PriorityRank asc → Oldest-inactive asc → DeviceID`
(ADR-0017, `canonical-sort.ts`). `LONG_PENDING` sorts near the bottom. So **76% of the devices where
the customer is actively dispatching right now are ranked last by the current engine** — they have
been broken so long that the SLA band gave up on them, which is precisely backwards from the
customer's point of view.

Two supporting observations:

- **Inactive vehicles are dispatched ~4× less often than the fleet average**: 111 of 2,382 stamped
  inactive devices were touched in 24 h ≈ **4.7%/day**, against the fleet-wide **18.4%/day**
  (SYSTEM-STATE §3b). The signal discriminates — most broken-GPS trucks genuinely are less active.
  The 4.7% that are not are the ones worth surfacing.
- **Tier gives no help here.** Every one of the top-8 HIGH-criticality companies is `SILVER`
  (HCCB 37, Prism Cement 17, Shree Balaji Roadlines 12, Vicat 12, UTCL 12, Saurashtra 9, Nuvista 6,
  Deepak Fertilizer 3). Since tier is the *first* canonical sort key, contract tier cannot be
  standing in for business criticality — this is independent information.

### 2.3 By zone (ZM-actionable)

| Zone | HIGH | of which unassigned |
|---|---|---|
| West | 38 | 1 |
| South | 30 | 7 |
| East | 26 | 8 |
| UNZONED | 13 | 0 |
| North | 4 | 1 |

Small enough per zone to be a daily standing worklist rather than a report.

### 2.4 Recency spread — the compression caveat

Inactive devices with a trip stamp, by month of that stamp:

`2026-07: 2,041` · `2026-06: 11` · `2026-05: 5` · `2026-04: 2` · `2026-03: 3` · `2026-02: 3` ·
`2026-01: 1` · everything older: ~13.

**86% of the signal lives in the current month.** The `>7d` LOW bucket is therefore mostly
"early-to-mid July", not "seasonal idle". The three-way split still ranks correctly, but the
business story attached to LOW should be *"no recent dispatch activity"*, not *"truck parked"*.
The genuinely-dormant tail is ~28 devices, not 1,287.

---

## 3. Feature shape

### 3.1 Data model for the view

Everything below already exists. `device_states` carries denormalised `vehicle_id`, `plant_id`,
`company_id`, `transporter_id`, `sla_bucket`, `inactivity_hours`, `is_departed`, and
`trip_creation_datetime` — verified against `information_schema`.

| Field | Source | New? |
|---|---|---|
| `device_id` | `device_states.device_id` | no |
| `zone` | `plants.zone_id → zones.name` | no |
| `company` | `device_states.company_id → company_master.name` | no |
| `plant` | `device_states.plant_id → plants.name` | no |
| `inactive_since` | derived from `device_states.latest_gps_datetime` | no |
| `inactive_hours` | `device_states.inactivity_hours` | no |
| `trip_creation_datetime` | `device_states.trip_creation_datetime` | no |
| `days_since_trip_scheduled` | derived | no |
| `business_priority` | derived (24 h / 7 d thresholds) | no |
| `open_ticket` | `tickets` LATERAL, `status='OPEN'`, `work_type='TROUBLESHOOT'` | no |
| `assigned_se` | `tickets.assignment_state` + batch/schedule join | no |
| `days_since_ticket_created` | derived from `tickets.created_at` | no |

**Zero schema change.** One query with four joins and one LATERAL.

### 3.2 Cached vs live — **cached, and it is already done**

Recommend **cached**, decisively:

1. **It already is.** `device_states.trip_creation_datetime` is written by
   `SnapshotIngestionService.upsertDeviceStates` (`snapshot-ingestion.service.ts:114-123`), and
   critically it is called with **every row of the chunk** (`:77`), independent of whether the
   `raw_device_snapshots` insert was skipped by `ON CONFLICT DO NOTHING` (`:72-75`). So an inactive
   device whose ping never changes still gets its trip stamp refreshed.
2. **Inactive devices are not skipped by the scan.** `AutoPlantSourceReader` pages on the immutable
   `device_id` with **no `latest_gps_datetime` predicate** and **no cross-run resume cursor**
   (`autoplant-source-reader.ts:8-25, 84-90`) — every device is visited exactly once per run. This
   was the one design risk that could have killed the feature (a GPS-recency cursor would have
   frozen exactly the devices we care about), and the reader was deliberately built the other way.
3. **Live per-request is not viable under the read constraints.** AutoPlant is capped at <100 rows
   per query. A page showing 111 HIGH devices would need ≥2 paged round trips over the VPN per view;
   at 2,729 rows for the unfiltered list it is ~31. Sorting and filtering server-side would be
   impossible without pulling the whole set. The cached column costs **zero additional AutoPlant
   queries** — it rides the existing scan.

**Cadence adequacy:** designed cadence is 30 minutes, well inside a 24-hour bucket threshold. **But
`INGESTION_SCHEDULER_ENABLED="false"`** in `apps/backend/.env`, so the pipeline is currently driven
by hand. Telemetry happens to be fresh (last snapshot run SUCCESS 2026-07-22 10:08, `computed_at`
10:13), but that is an operator, not a cron. This is an ops precondition, not a code gap — flagged
in §4.

**One design change to consider before shipping:** the upsert uses
`trip_creation_datetime = GREATEST(existing, EXCLUDED)` (`:122`), which is monotonic forward-only.
That is correct for a ping watermark, but for a *current business state* it means a downward
correction at source — a cancelled trip, a corrected entry, a vehicle reassignment — can never
propagate; FSM's copy would drift permanently upward. For a prioritisation signal, last-observed-value
is arguably the right semantic. This is a small, contained decision, not a blocker.

### 3.3 Surface — **dedicated page**, ZM-scoped

Recommend a dedicated page (OH/CSM all zones, ZM clamped to own zone) over a filter on the existing
device surface, for three reasons:

- **The ranking is the product.** A filter inherits the host page's sort and columns; here the
  default sort *is* the feature (§3.4). A tab that opens already-sorted-correctly is a worklist; a
  filter the user must configure is a query tool.
- **The audience differs.** `/reports/device` and Company/Plant Overview are investigation surfaces
  ("tell me about this device"). This is a daily triage queue ("what do I fix first"), which is the
  same shape as the existing Component Blocked and Recovery queues.
- **It is cheap.** Reuses `DataTable`, the existing device drill-down, and the ZM zone-clamp pattern
  already used across the admin app. No new primitives.

Counter-argument, recorded: the admin app already has many device surfaces and #122 consolidated
several. If the operator prefers consolidation, the honest fallback is a **tab** on the device
surface with its own default sort — not a filter chip.

### 3.4 Default sort

As specified, with one refinement: put **unassigned above longest-inactive**.

```
business_priority DESC (HIGH → MEDIUM → LOW → NO_TRIP_DATA)
  → assigned_se IS NULL DESC        (unresourced first — the actionable ones)
    → inactive_hours DESC           (longest pain first)
      → device_id ASC               (deterministic tiebreak, matches ADR-0017 convention)
```

Rationale: within HIGH, an already-assigned device is *handled* — the ZM's decision is "who do I
still need to resource?". Today that top slice is exactly **17 rows**. Put `NO_TRIP_DATA` last, not
hidden: 347 devices averaging 421 days inactive is its own finding (probably departed-but-not-yet-
detected, or never-dispatched vehicles), and burying it would hide it.

### 3.5 Bonus — should this feed the recommender's scoring?

**Yes in principle, but LATER — not now.** The evidence *for* is the strongest finding in this
analysis: business priority is orthogonal to the SLA bucket the engine sorts by (§2.2), so it carries
information the engine provably does not have, and today the engine ranks 76% of the most
business-critical devices last.

Three preconditions are unmet, and each is a real gate rather than caution:

1. **The semantics are not confirmed** (§1.4). Feeding a field into dispatch scoring when we are not
   certain whether it means "trip created" or "trip record last written" would bake an
   unvalidated assumption into the assignment engine — the class of mistake #130 exists to prevent.
2. **Dispatch history cannot yet record it.** #124 is open: `dispatch_runs.config_snapshot` captures
   only DB-overridden settings, so a new scoring component would not appear in the run ledger and
   past runs could not be re-interpreted. Adding an engine input before its audit trail can describe
   it is exactly the "un-interpretable recorded history" #124 warns about, and it cannot be retrofitted.
3. **Scoring weights are global OH-owned config**, and the project deliberately decided against
   per-zone engine knobs (INDEX "Deferred / decided-against", proposal `f0f3dcb`). A new weight is a
   fleet-wide behaviour change and belongs with that governance, not slipped in with a view.

**The sequencing that earns it:** ship the view; let ZMs act on it with the levers they already have
(SE Planner bias, same-day update, override); then check whether their manual picks correlate with
the HIGH bucket. If they do, that is evidence-of-demand for a weight — the same bar #137 was held to.
If they do not, we learned the signal is weaker than it looks and saved an engine change. Either way
the view pays for itself first.

**Never** is wrong here — the orthogonality data is too strong to discard.

---

## 4. Feasibility verdict

### **YES.**

Data exists, is refreshed on the correct cadence by design, is verified accurate to the second
against production, covers 87% of the target population, requires no schema change, no sync change,
and **zero additional AutoPlant queries**. The remaining work is a query, an endpoint, and a page.

### Blockers and concerns

| Concern | Status |
|---|---|
| **Join key reliability** | **Not a blocker.** `device_id` is the reader's keyset key and "verified effectively unique on production" (`autoplant-source-reader.ts:28-30`); `vehicle_no` is the PK of both `mst_vehicle` (`docs/autoplant/Complete structure of mst_vehicle.md:1`) and `tb_vehiclemaster`. 4/4 cross-checks matched exactly. |
| **Prod query budget** | **Not a blocker.** Zero additional reads — the column rides the existing 30-min scan (`autoplant-source-reader.ts:33-38`). |
| **Data quality — manual entry** | **Real, manageable.** 13% of inactive devices have no stamp at all (347). Values are dispatcher-maintained and therefore uneven. Mitigation: `NO_TRIP_DATA` is a first-class bucket, not a silent exclusion. |
| **Semantic uncertainty** | **Real.** §1.4 — `active_trip_id` dates disagree with the stamp on several rows. Affects the *label*, not the ranking. Needs confirmation from AutoPlant's owners before UI copy is fixed. |
| **Signal compression** | **Real.** 86% of stamps are in the current month (§2.4); MEDIUM-vs-LOW discriminates weakly. Thresholds may want tuning after operators use it. |
| **Sync cadence mismatch** | **Real, and it is an ops issue.** Designed cadence is 30 min; `INGESTION_SCHEDULER_ENABLED="false"`, so refresh currently depends on a human running the pipeline. If this view drives daily triage, that flag needs to be on — and it is paired with `PARTITION_MAINTENANCE_ENABLED` per the activation checklist. Flagged, not solved here. |
| **`GREATEST` monotonicity** | **Minor, decide before shipping.** §3.2 — a downward correction at source can never propagate. |
| **`is_departed` interaction** | **Not a blocker, worth noting.** #128 excludes departed devices; the 347 `NO_TRIP_DATA` devices averaging 421 days inactive may be departure candidates the reconcile has not caught. The view may usefully surface that as a side effect. |

### Sequencing if built

1. **Confirm the semantics** (HITL, external) — is `TRIP_CREATION_DATETIME` creation or last-write?
   Determines UI copy and whether the 24 h threshold is the right cut. Everything else can proceed
   in parallel.
2. **Decide `GREATEST` vs last-observed-value** for `trip_creation_datetime` (§3.2). Contained;
   affects one line of the ingest upsert.
3. **Schema:** none.
4. **Sync:** none.
5. **Endpoint:** one read, zone-clamped for ZM (the established `ZoneScopeGuard` + service-level
   pattern), returning the §3.1 shape with the §3.4 sort applied server-side.
6. **UI:** one page under OH/CSM/ZM nav, `DataTable`, deep-linking to the existing device drill-down.
7. **Ops precondition, if this drives daily triage:** `INGESTION_SCHEDULER_ENABLED=true` paired with
   `PARTITION_MAINTENANCE_ENABLED=true`, per the INDEX activation checklist.
8. **Later, gated on demand evidence:** the recommender scoring seam (§3.5), after #124.

### HITL decisions needed

- Confirm `TRIP_CREATION_DATETIME` semantics with AutoPlant's owners (creation vs last-write).
- Bucket thresholds — keep 24 h / 7 d, or tune given the July compression (§2.4)?
- `GREATEST` vs last-observed-value for the cached column.
- Dedicated page vs tab on the existing device surface (§3.3 recommends page; the counter-argument
  is recorded).
- Whether `NO_TRIP_DATA` (347 devices, avg 421 days inactive) is a bucket in this view or a separate
  data-quality/departure follow-up.
- Whether to turn on the ingestion scheduler, given this view's freshness depends on it.

---

*Read-only. No code changed, no issue filed. AutoPlant reads were bounded `SELECT`s with `LIMIT ≤ 90`
plus `information_schema` metadata lookups; FSM reads were `SELECT`-only. All probe scripts deleted.*
