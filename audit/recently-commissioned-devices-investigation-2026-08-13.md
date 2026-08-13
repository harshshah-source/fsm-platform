# Recently Commissioned Devices (last 3 months) — investigation & design report

**Date:** 2026-08-13 · **Mode:** read-only investigation. No application code, schema, migration or
data was changed. All FSM figures were taken live from `localhost:5433/fsm` this session; AutoPlant
figures are quoted from `audit/commissioning-view-feasibility.md` (2026-08-09) and not re-measured.

**Reading order followed:** `CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md` §2.2/§3a/§3b/§3c/§3l →
`.scratch/fsm-platform-v1/INDEX.md` → `audit/commissioning-view-feasibility.md` →
`issues/232-commissioning-cohort-view.md` → code → live database.

---

## Verdict

**Most of this feature already exists and has an owner. The single most important thing this
investigation found is that it is measuring the wrong population, and that nobody has noticed
because no screen calls it.**

Three statements, in order of how much they change the plan:

1. **Do not design a new subsystem.** `device_commissioning` (the append-only fitment fact),
   `device_states.first_reported_at` (the write-once first-ping stamp), and two manager-scoped
   endpoints — `GET /api/reports/commissioning/cohort` and `/installers` — were built on 2026-08-10
   and committed on 2026-08-13 under **[#232](../.scratch/fsm-platform-v1/issues/232-commissioning-cohort-view.md)**.
   They implement cohort membership, online/pending/failed grading, time-to-first-report percentiles,
   per-plant and per-installer breakdowns, ZM zone clamping and measured window ceilings. The
   remaining gap on #232 is its **admin surface** — the open parity-gate item.

2. **#232's acceptance criterion AC-2 ("validate against live `fsm`") has now been executed, and it
   fails.** The cohort query has **no operational-fleet predicate**. Measured live over the last 90
   days: **6,832 fitments, 4,014 online, 2,668 "failed" — a 39% install-failure rate.** Restricted to
   the operational fleet the rest of the platform reports on (`device_states.is_departed = false`),
   the same window is **2,645 fitments, 2,368 online, 130 pending, 147 failed — 5.6%.** 4,127 of the
   6,405 cohort devices are **departed** (returned to warehouse, Issue 128), and a departed device is
   silent because it is in a box, not because its install failed. This is the exact defect class #176
   closed on the dashboard, reintroduced in a new surface. It must be fixed **before** any screen
   renders these numbers.

3. **"Monitor how inactivity changes over time" has no trustworthy source today, and the cheap
   correct answer is not the obvious one.** FSM keeps no historical device-status series
   (`device_states` is overwritten in place; `raw_device_snapshots` is 7-day retained). The obvious
   substitute — reconstructing silence from `failure_cycles` intervals — is currently **distorted**:
   1,799 of the cohort's 2,183 failure cycles are still `OPEN` because auto-recovery has never
   executed (#229 — no caller until `INGESTION_SCHEDULER_ENABLED` flips), so that series would rise
   monotonically as an artefact. The honest, derivable-today trend is the **cohort resolution curve
   by hours-since-fitment**, computed from the two stored facts with no history table, no new job and
   no dependency on the scheduler.

**Net: the minimum change is one backend correctness fix, one small derived endpoint, one device-list
filter, and the admin page #232 already owes. No new tables, no new modules, no new background jobs,
no AutoPlant query-load change.**

---

## 1. Current commissioning architecture

### 1.1 The lifecycle, end to end

```
AutoPlant MySQL (VPN, read-only, DBA <100-rows-per-query cap)
  ap_widgets.tb_vehiclemaster                    ap_masters.mst_vehicle / mst_plant / mst_company
    FIRST_INSTALLED_DATE_TIME  ── the fitment anchor
    FIRST_INSTALLED_BY         ── installer login string
    INSTALLATION_REMARK        ── controlled vocabulary
    latest_gps_datetime        ── liveness
        │
        │  [a] MASTER SYNC  (daily 02:00, INGESTION_SCHEDULER_ENABLED — currently OFF; run manually)
        │      master-sync.service.ts → mapDevice / mapCommissioning
        ▼
  FSM Postgres
    devices / vehicles / plants / companies       ← mirror, anti-drift (FSM-owned cols excluded)
    device_commissioning                          ← APPEND-ONLY fitment fact  (step 6 of the sync)
        │
        │  [b] SNAPSHOT INGESTION  (every 30 min, same master switch)
        │      snapshot-ingestion.service.ts — set-based unnest upsert
        ▼
    device_states.latest_gps_datetime  = GREATEST(existing, incoming)      ← moves forward only
    device_states.first_reported_at    = COALESCE(existing, incoming)      ← WRITE-ONCE, offset 0
        │
        │  [c] DEVICE-STATE RECOMPUTE (same tick) — device-state.service.ts
        ▼
    is_inactive · inactivity_hours · sla_bucket · eligible_for_uptime · is_departed
        │
        ├──[d] auto-recovery pre-check → [e] ticket creation → [f] recommender → [g] dispatch …
        │
        └──[l] COMMISSIONING REPORTS  (#232, read-only, no writer)
               commissioning-aggregation.service.ts
               GET /api/reports/commissioning/cohort      ← the "recently commissioned" endpoint
               GET /api/reports/commissioning/installers  ← install quality over a longer lookback
                     │
                     └── (nothing consumes these — no admin page, no API client)
```

### 1.2 Which AutoPlant fields establish commissioning

Settled by the 2026-08-09 feasibility read against AutoPlant production; not re-litigated here.

| Field | Verdict | Evidence |
|---|---|---|
| **`FIRST_INSTALLED_DATE_TIME`** | **The anchor.** 62,987/62,994 populated (99.99%), no pre-2000, no epoch-zero, no future dates. | feasibility §2.1 |
| **`FIRST_INSTALLED_BY`** | Real per-technician login. 183 distinct values, no user master to resolve against. `NA` rate fell 100% (2021) → 12.9% (2026). | §1.2, §1.3 |
| **`INSTALLATION_REMARK`** | Controlled vocabulary and the **strongest failure predictor available** — see §3.3. | §1.5 |
| `FIRST_INSTALLED_COMPANY_ID` | **Not** an installer — it is the owning company, in 62,992 of 62,992 rows. Discarded. | §1.1 |
| `SIGNAL_RECEIVED_TIME` | Useless — exactly equal to `latest_gps_datetime` in all 24,017 populated rows. | §2.3 |
| `TRIP_CREATION_DATETIME` | Not an install anchor — 17,634 rows have a trip predating the install. Rides the telemetry tick as live trip state. | §2.3, SYSTEM-STATE §3b |

**Commissioning is therefore defined by the source, not invented by FSM:** a fitment is
`(device, vehicle, FIRST_INSTALLED_DATE_TIME)`. Note the semantics — it is *"first fitted to **this
vehicle**"*, not "first ever fitted". A device moved to a new vehicle is genuinely a new commissioning
event.

### 1.3 Can commissioning be rewritten at source? — Yes, and it is

This is the fact that decides the architecture. Measured against `mst_vehicle_log` (805,554 change
rows over 81,539 devices):

| | |
|---|---:|
| Devices where `first_installed_dt` changed | **10,565 (12.96%)** |
| …moved by more than a year | 1,757 |
| Devices where `first_installed_by` also changed | 5,929 (7.28%) |

`tb_vehiclemaster` **rewrites fitment in place on re-mapping**. Anything reading only the live source
row measures a silently-mutating population: a device that failed commissioning in June and was
re-mapped in July presents as a July install, and June's failure — with the name of whoever performed
it — ceases to exist.

### 1.4 How FSM preserves commissioning history

`device_commissioning` (migration `20260809120000`), written by `MasterSyncService.appendCommissioning`
as **step 6** of the sync:

- **Append-only structurally, not by convention.** The unique index **is** the fitment identity
  (`device_id, vehicle_id, installed_at`) and the writer is `createMany({ skipDuplicates: true })` →
  `INSERT … ON CONFLICT DO NOTHING`. There is no UPDATE path. A re-map changes `vehicle_id`, which is
  a new identity, so it appends and the prior row is never touched.
- **`NULLS NOT DISTINCT` is load-bearing and Prisma 7.8 cannot express it.** Verified present live
  this session (`pg_index.indnullsnotdistinct = true`). Without it, every NULL `installed_at` /
  `vehicle_id` row re-inserts on every daily sync — unbounded silent growth on a cron. The migration
  file carries a prominent warning; `device-commissioning.e2e-spec.ts` asserts it against the live DB.
- **Inert by construction.** The whole body is one try/catch outside any `$transaction`, running after
  every mirror write, so a fitment-write failure can neither fail the sync nor roll back the mirror.
  The run records `entity_stats.commissioning`.
- **Scoped to the devices the run actually mirrored** (~21k), not the widened ~48.5k read — so the
  table describes the same population as every other FSM surface.
- **No foreign keys**, deliberately, matching `master_sync_rejects`: a fact must record even for a
  device the mirror has not caught up on (#227).

`device_states.first_reported_at` (same migration) is the other half — the first GPS ping ever seen,
write-once via `COALESCE`, written at **true UTC (offset 0)**. Nothing else in FSM retains it:
`latest_gps_datetime` is overwritten every tick and `raw_device_snapshots` drops partitions after 7
days. **It is observable exactly once, as it happens.**

### 1.5 Live state of the capture (measured this session)

| Measure | Value |
|---|---:|
| `device_commissioning` rows | **25,387** (24,960 distinct devices) |
| …with `installed_at` | 25,383 |
| …with `installed_by` | 18,782 (74.0%) |
| …with `installation_remark` | 19,723 (77.7%) |
| Rows written across | **6 master-sync runs** (117, 118, 119, 124, 125, 126) |
| `installed_at` range | 2021-02-11 → 2026-08-13 |
| Table size | 7,816 kB |
| `device_states` rows / with `first_reported_at` | 27,555 / **23,636** |
| `device_states` never-reported (`latest_gps_datetime IS NULL`) | 2,098 |

**Append-only is working in production shape.** Run 126 (today): `observed 24,659 · inserted 142 ·
skipped 24,517 · updated 0`. Six runs, monotonically growing, zero updates — exactly the designed
behaviour.

Two record corrections against the current docs:

- SYSTEM-STATE §3l and #232 both state `device_commissioning.first_reported_at` is populated on
  **0 of 24,294 rows**. It is now **371 of 25,387** — later runs snapshot the value for devices that
  had begun reporting. This does **not** change the design decision (that column remains an
  observation-time snapshot and must not be used to decide "online"), but the stated figure is stale.
- The table is no longer at 24,294 rows; it is at 25,387 across 6 runs.

---

## 2. Current definitions — and where they disagree

This is the section that matters most for not breaking anything.

| Term | Definition in force | Owner |
|---|---|---|
| **Fitment / commissioning event** | one `device_commissioning` row = `(device, vehicle, installed_at)` as observed | `master-sync.service.ts` |
| **Recently commissioned** | derived: `installed_at >= now() - N days`. **Nothing is stored, nothing moves.** | `commissioning-aggregation.service.ts:193` |
| **Online / commissioned** | `device_states.first_reported_at IS NOT NULL AND first_reported_at >= installed_at` | `gradedSource`, one SQL expression, computed once, both endpoints derive from it |
| **Pending** | not commissioned **and** `installed_at > now() - graceHours` | same |
| **Failed** | not commissioned **and** `installed_at <= now() - graceHours` | same |
| **TTFR (time to first report)** | `first_reported_at - installed_at`, **only when `installed_at >= COMMISSIONING_TTFR_EPOCH`** | `commissioning.config.ts` |
| **Operational fleet** | `device_states.is_departed = false` | `FLEET_COUNT_COLUMNS`, `dashboard.service.ts:84` |
| **Warehouse** | `is_departed = true` — removed from field ops, in a box, **not broken** | same |
| **Inactive (operational)** | `is_departed = false AND is_inactive AND sla_bucket IS NOT NULL` | same |
| **Never reported** | derived at read time from `latest_gps_datetime IS NULL` — deliberately not a stored column (#223) | same |
| **Departed** | an open `device_departures` row, reconciled from the master read (Issue 128) | `reconcileDepartures` |
| **Deactivated plant** | `EXCLUDE_DEACTIVATED_PLANTS` — excluded from ticket creation, dashboard counts, recommender, exports (#119) | `dashboard.service.ts:8` |

**`is_departed = false` is the platform-wide denominator for every operational rate.** The
commissioning endpoints are the only manager-facing read surface in the repo that does not apply it.

Two further definitional points worth stating because they are counter-intuitive:

- **Online is decided solely by `device_states.first_reported_at`**, never
  `device_commissioning.first_reported_at`. The latter is provenance, not outcome. A reader requiring
  both to agree would report near-zero commissioned devices forever.
- **`first_reported_at >= installed_at` is load-bearing.** A stamp *earlier* than the fitment it
  belongs to is not evidence of coming online — the write-once COALESCE captured a pre-existing
  device's last-seen ping the first time the tick ran after the column shipped. Without the
  comparison, a dead device re-mapped onto a new vehicle reports as a successful install.

---

## 3. Live validation — #232 AC-2, executed

All figures below are live from `fsm` this session, over the **last 90 days**.

### 3.1 What the endpoint returns today

| | fitments | online | pending (48 h) | failed | plants | installers |
|---|---:|---:|---:|---:|---:|---:|
| **As `/cohort` computes it now** | **6,832** | 4,014 (58.8%) | 150 | **2,668 (39.1%)** | 172 | 86 |

Median TTFR over the 517 post-epoch measurable samples: **14.59 h** — consistent with the
feasibility read's 17.26 h and with the "no commissioning tail" finding.

### 3.2 The defect — departed devices are counted as failed installs

6,405 distinct devices sit in that 90-day window. Their `device_states` posture:

| | count |
|---|---:|
| Cohort devices with a state row | 6,405 / 6,405 |
| **`is_departed = true` (warehouse)** | **4,127 (64.4%)** |
| `is_inactive = true` | 401 |
| `eligible_for_uptime` | 2,278 |
| `has_open_failure_cycle` | 1,799 |
| never reported (`latest_gps_datetime IS NULL`) | 579 |

Restricting to the operational fleet the rest of the platform reports on:

| | fitments | online | pending | failed | online % |
|---|---:|---:|---:|---:|---:|
| As computed now (all) | 6,832 | 4,014 | 150 | 2,668 | 58.8% |
| **`is_departed = false`** | **2,645** | **2,368** | **130** | **147** | **89.5%** |
| `is_departed = false` **and** remark not blank | 2,353 | 2,237 | — | — | **95.1%** |

**The headline failure rate moves from 39.1% to 5.6% on one predicate the platform already owns.**
A page shipped on the current query would send Operations after ~2,500 devices sitting in a warehouse.

### 3.3 The second contamination — the blank-remark bulk-load population

Cross-tab of the same 90-day window:

| Remark | Departed | Fitments | Online | Never-online % |
|---|---|---:|---:|---:|
| **(blank)** | false | 292 | 131 | **55.1%** |
| **(blank)** | true | **2,576** | 134 | **94.8%** |
| New Installation | false | 1,045 | 1,012 | **3.2%** |
| New Installation | true | 282 | 272 | 3.5% |
| Re-Installation | false | 305 | 273 | 10.5% |
| Re-Installation | true | 156 | 149 | 4.5% |
| Re-Mapping | false | 1,003 | 952 | **5.1%** |
| Re-Mapping | true | 1,173 | 1,091 | 7.0% |

Two things follow:

- **The blank-remark rows are almost entirely the departed bulk-load population** (2,576 of 2,868),
  and they carry a 94.8% never-online rate. They are migration writes, not fitments — the day-level
  signature confirms it: 378 rows on 2026-07-21 across **5 plants**, 348 on 07-02 across 7 plants,
  against a genuine field day like 08-09 at 232 rows across **52 plants**.
- **Genuine new installations sit at 3.2% never-online**, reproducing the feasibility survival curve
  (96.97% report within 12–24 h) on FSM's own stored data for the first time. The measurement holds.

### 3.4 TTFR distribution (post-epoch, live)

| Bucket | Devices |
|---|---:|
| < 1 h | 52 |
| 1–4 h | 87 |
| 4–12 h | 93 |
| **12–24 h** | **189** |
| 24–48 h | 91 |
| 48–72 h | 6 |
| > 72 h | 2 |

520 measurable samples; **97.7% inside 48 h, 99.6% inside 72 h.** The default `graceHours = 48` is
correct and now confirmed against FSM-stored data rather than inferred from a source-side survival
curve.

### 3.5 Grain check

| Rows per device in the 90-day window | Devices |
|---:|---:|
| 1 | 5,993 |
| 2 | 400 |
| 3 | 9 |
| 4 | 3 |

**6.4% of cohort devices have more than one fitment in 90 days.** Fitments, not devices, are the
correct grain for a quality measure — which is what the endpoints already do. But a device-level page
("show me the recently commissioned devices") must state which grain it is showing, or its count will
not match the cohort card above it.

---

## 4. Reusable existing components

Nothing in this feature needs to be invented. The inventory:

### Backend

| Asset | File | Reuse |
|---|---|---|
| Cohort + install-quality aggregation | `reports/commissioning-aggregation.service.ts` | **The feature core.** Extend, don't replace |
| Window ceilings + TTFR epoch | `reports/commissioning.config.ts` | Measured performance contract |
| Installer person/machine classification | `reports/installer-classification.ts` | 4 classes, calibrated on all 158 distinct logins |
| Two endpoints, `@Roles(...MANAGER_ROLES)`, ZM-clamped | `reports/reports.controller.ts:48,71` | Already role-gated and validated |
| **`FLEET_COUNT_COLUMNS` / `EXCLUDE_DEACTIVATED_PLANTS`** | `dashboard/dashboard.service.ts:8,84` | **Exported for exactly this** — `reconciliation.service.ts` already imports them rather than restating |
| Device list with zone/company/plant/status/bucket filters | `devices/devices.controller.ts:51` | Drill-through target |
| Per-device cycles + lifetime downtime trend | `devices/…:100,109` | Individual device drill-in, already built |
| Fleet Directory per-plant numerator/denominator + `withRates()` | `dashboard.service.ts:526,76` | Closest aggregate shape |
| Activity Trend range handling | `dashboard.service.ts:855` | Closest time-axis shape |

### Frontend

| Asset | Path | Reuse |
|---|---|---|
| `MetricStrip`, `DataTable`, `PageHeader`, `FilterBar`, `TableDownloadButton`, `KpiInfo` | `components/data/` | The whole page chrome |
| `TrendChart`, `BarChartCard`, `SlaBucketBarChart`, `DistributionBar`, `BarList` | chart kit | Every panel except one |
| `ZoneDrilldownSection` scope-chip band pattern | `pages/reports/ZoneDrilldownSection.tsx` | The zone/status/snapshot header band |
| `kpiCatalog.ts` + `KpiInfo` | `lib/kpiCatalog.ts` | Provenance for every figure (#232 AC-3) |
| Reports reference image | `docs/ui/desktop/v2-reference/21-reports.png` | KPI strip → two bar panels → breakdown table |
| Route + nav registration | `AppRoutes.tsx`, `components/shell/nav.ts:114` | One `<Route>`, one `Analytics` nav entry |

**Not present, and genuinely new:** a hours-since-fitment bucket chart. It is a bar chart over
pre-computed buckets, so this is a new *component*, not a new *capability*.

**Not reusable:** Ops Explorer. `buildDatasetQuery` emits exactly one statement shape with no
`GROUP BY`, no `HAVING` and no aggregate clause; the cohort window would have to be frozen into
registry SQL. `reconciliation.service.ts` hit the same wall and escaped the registry onto its own
endpoint — the precedent is decisive.

---

## 5. What historical telemetry actually exists

The requirement "monitor how their inactivity/status changes over time" is the one place where the
existing system genuinely cannot serve the ask as stated. The honest inventory:

| Source | Grain | Retention / state | Usable for cohort trend? |
|---|---|---|---|
| `device_states` | 1 row/device | **overwritten in place**, no history | **No** |
| `raw_device_snapshots` | 1 row/ping | daily partitions, `telemetry_retention_days` default **7** | **No** — and 52 partitions survive only because `PARTITION_MAINTENANCE_ENABLED` is off, a configuration accident, not a guarantee |
| `soft_inactive_count_history` | zone × half-day | 130 rows, from 2026-07-21 | **No** — zone-keyed, not cohort-keyed |
| `device_downtime_summary_monthly` | device × month | cron-driven month-start rebuild | Partially — device-keyed, but a 3-month cohort yields 1–3 points |
| `failure_cycles` | 1 row/inactivity episode, `opened_at`/`closed_at` | append + close, no retention | **In principle yes — but see below** |
| `device_commissioning` + `first_reported_at` | 1 row/fitment, 2 stored instants | permanent | **Yes** |

### The failure_cycles route is currently distorted — do not build on it yet

Interval-overlap reconstruction from `failure_cycles` is the textbook way to answer "how many of this
cohort were silent on day X" without a snapshot table. Measured live for the operational 90-day
cohort: **2,183 cycles over 1,963 devices, of which 1,799 (82%) are still `OPEN`**, spanning
2026-07-09 → today.

That 82% is not a fleet health signal. Per SYSTEM-STATE §3d, **auto-recovery had no production caller
at all until #229** and *still has not run* — it is gated behind `INGESTION_SCHEDULER_ENABLED`, and
enabling it is a deliberate, operator-gated ~9,888-closure event. Until then, cycles open and
essentially never close, so any calendar-time series built from them **rises monotonically as an
artefact of the scheduler being off**. Publishing that as "cohort inactivity over time" would be
confidently wrong.

### The trend that *is* derivable today

**Cohort resolution by hours-since-fitment** — for the fitments in the window, what fraction had come
online by 4 h, 12 h, 24 h, 48 h, 72 h, and what fraction never did. It is computed from
`installed_at` and `first_reported_at` alone: two stored facts, one subtraction, no history table, no
new job, no dependency on the scheduler, and no dependency on ticketing. §3.4 above is that chart,
already computed.

It also answers the operational question better than a calendar series does. "Is this week's install
batch coming online as fast as last month's?" is a cohort question, not a calendar question.

**Recommendation: build the hours-since-fitment resolution curve now; defer the calendar-time
inactivity series until #229's auto-recovery is actually running, and record it as a follow-up rather
than shipping a distorted version of it.**

---

## 6. Proposed feature architecture

### 6.1 Shape

```
  Route  /reports/commissioning          (Analytics nav group, MANAGER_ROLES, ZM zone-clamped)
    │
    ├── scope band          zone · population · window · data-as-of      [ZoneDrilldownSection pattern]
    ├── KPI strip           Fitments · Online · Pending · Failed · Median TTFR   [MetricStrip + KpiInfo]
    ├── resolution curve    % online by hours since fitment  (NEW component, bar over buckets)
    ├── by remark           install-type split                            [BarList / DistributionBar]
    ├── by plant            fitments / online / pending / failed / TTFR   [DataTable → /reports/device]
    └── by installer        installs / never-online % / distinct days     [DataTable, kinds labelled]

  Backend  reports/commissioning-aggregation.service.ts   (existing — extended, not replaced)
    GET /api/reports/commissioning/cohort      ← + population filter, + resolution buckets
    GET /api/reports/commissioning/installers  ← + population filter
  Devices  GET /api/devices?commissionedWithinDays=90     ← NEW optional filter, drill-through
```

### 6.2 The four design rules

1. **No new table, no new module, no new cron.** Cohort membership stays **derived** —
   `installed_at >= now() - N days` is the whole predicate. Nothing moves a device between states;
   a device ageing out of the window requires no write. This is already how #232 works and it is
   correct.
2. **Population is defined once, in `dashboard.service.ts`, and imported.** The cohort service must
   `import { EXCLUDE_DEACTIVATED_PLANTS }` and reuse the `is_departed = false` predicate rather than
   spelling it a second time — the precedent is `reconciliation.service.ts`, and the reason is that a
   second spelling only ever verifies that it agrees with itself.
3. **"Commissioned" keeps exactly one definition**, the `gradedSource` SQL expression. Both endpoints,
   both count families and every timing sample already derive from it. Nothing gets recomputed in
   TypeScript.
4. **Read-only, everywhere.** No writer, no state machine, no flag on `devices`. The feature adds
   zero rows to any table.

### 6.3 Population model — the decision that fixes §3.2

Introduce one query parameter, `population`, and default it to the safe answer:

| `population` | Predicate | Meaning |
|---|---|---|
| **`operational`** *(default)* | `ds.is_departed = false` + `EXCLUDE_DEACTIVATED_PLANTS` | Devices in the field. **The install-quality measure.** |
| `all` | no predicate (today's behaviour) | Every fitment, warehouse included. Reconciliation / audit only. |

Rendering both counts on the page (`2,645 operational · 4,187 warehouse`) is what stops someone
reconciling the page against AutoPlant and concluding it is broken. This is the Fleet Composition
funnel's "name every drop" pattern.

---

## 7. Data & query strategy, performance

### 7.1 The query is already the right shape

`gradedSource` opens a CTE, `GROUPING SETS ((), (plant…), (installer))` produces totals and both
breakdowns **in one pass** — so the totals and the breakdowns cannot disagree about a device sitting
exactly on the grace line. That property is worth preserving; the resolution-curve buckets should be
added as further `count(*) FILTER (…)` columns on the **same** pass, not as a second query.

### 7.2 Measured live this session

`EXPLAIN (ANALYZE, BUFFERS)` on the 90-day cohort with both `GROUPING SETS`, over 25,387
commissioning rows and 27,555 device states:

```
GroupAggregate  (actual time=20.441..23.923 rows=260)
  ->  Sort  (rows=6832)  Sort Method: quicksort  Memory: 664kB      ← in memory, no disk spill
      ->  Hash Right Join  (rows=6832)
          ->  Seq Scan on device_states  (rows=27555)               ← 4.6 ms, 15 MB table
          ->  Hash Join
              ->  Bitmap Heap Scan on device_commissioning          ← device_commissioning_installed_at_idx
Execution: ~23.9 ms   Buffers: shared hit=1634 (all cached, zero reads)
```

**23.9 ms at the maximum window, all buffers cached, sort in memory.** This confirms the ceilings in
`commissioning.config.ts` (6.8/9.7 ms measured at smaller windows, 62.7/172.1 ms at 4× the one-year
projection) and confirms that the plan holds at the 90-day boundary. **No new index is warranted** —
the config file records that three candidates were measured and the best bought 9%, because the cost
is the sort forced by the `count(DISTINCT …)` aggregates, not the access path.

The `device_states` seq scan is not worth fixing: 15 MB fully cached at 4.6 ms, and the hash join
needs most of the rows anyway.

### 7.3 The window ceilings, and the 3-month ask

`COHORT_DAYS.max = 90`. **"Last 3 months" is 90–92 days depending on how you count**, and
`cohortDays=92` returns `400 WINDOW_OUT_OF_RANGE` today. The difference is 14 fitments (6,846 vs
6,832) — immaterial to the measure, material to whether the page's own label is true.

**Recommendation: keep the 90-day ceiling and label the page "last 90 days", not "last 3 months".**
The ceiling is a measured contract; loosening it to satisfy a label is the wrong trade. This needs
your sign-off (§11, D1).

### 7.4 Growth

At the observed ~97 fitments/day, `device_commissioning` grows ~35k rows/year on a 7.8 MB base. The
one-year projection is ~60k rows; the config's stress fixture was 242,940 rows (≈4× that) and still
held the plan. **No partitioning, no retention policy and no archival is needed for the foreseeable
fleet.** It belongs on the §2.9 "append-only, no retention" list alongside `audit_logs` and
`ticket_events`, and inherits #104 if that list ever gets a policy.

### 7.5 AutoPlant load — unchanged

**This feature adds no AutoPlant queries at all.** Everything it reads is already mirrored. The
commissioning fact rides the master sync's existing paged reads (≤90 rows/query, DBA <100 cap) with
no additional query, and `appendCommissioning` reads only FSM Postgres. The DBA cap is untouched.

---

## 8. Impact & safety analysis

Assessed against every subsystem named in the brief. The short version: **a read-only report over two
existing tables changes nothing, provided the population fix is scoped to the commissioning endpoints
and does not touch the shared predicates it imports.**

| Subsystem | Impact | Why |
|---|---|---|
| **Ingestion (master sync)** | **None.** No change proposed. `appendCommissioning` already runs, is inert by construction, and its scope pin stays as-is | it runs after every mirror write, outside any transaction |
| **Snapshot ingestion / `first_reported_at`** | **None.** Write-once column, already landed, dual-write pinned by 7 tests | `snapshot-first-reported-dualwrite.e2e-spec.ts` |
| **Device-state recompute** | **None.** The feature reads `device_states`; it never writes it and adds no column | `device-state.service.ts` untouched |
| **Existing dashboards / KPI strip** | **None**, *provided* the fix **imports** `FLEET_COUNT_COLUMNS`/`EXCLUDE_DEACTIVATED_PLANTS` rather than editing them. Import-only is a compile-time-checked one-way dependency | `reconciliation.service.ts` precedent |
| **Device directory / detail pages** | **Additive only.** One optional `commissionedWithinDays` query param; absent ⇒ byte-identical behaviour | `devices.controller.ts:51` already has 8 optional filters |
| **Tickets / failure cycles** | **None.** The feature creates no cycles, closes none, reads none in the shipped slices | the `failure_cycles` route is explicitly deferred (§5) |
| **SLA** | **None.** No bucket is computed, stored or reinterpreted. The cohort's bucket spread is displayed, never redefined | `sla-bucket.ts` untouched |
| **Engineer workflows / dispatch / recommender** | **None.** No recommendation, schedule, assignment or hard filter is read or written | zero overlap |
| **Fleet uptime** | **None.** `eligible_for_uptime` is not read and `device_downtime_summary_monthly` is not written | the monthly cube is untouched |
| **Existing reports** | **None.** New endpoints under `/reports/commissioning/*`; existing routes unchanged | additive controller methods |
| **Existing APIs** | **One behaviour change, and it is the point:** `/reports/commissioning/cohort` and `/installers` will return a different (correct) population by default. **Blast radius is zero — nothing consumes them.** This is precisely why the fix must land *before* the page | grep: no `api/reports.ts` entry, no page, no test outside the module |
| **Indexes / queries** | **None added.** Existing `device_commissioning_installed_at_idx` carries the plan at 23.9 ms | §7.2 |
| **Historical data retention** | **None.** No new retention obligation; `device_commissioning` is small and append-only | §7.4 |
| **AutoPlant query limits** | **None.** Zero new source queries | §7.5 |

**The one genuine risk of harm** is a well-meaning "consistency" change that edits `FLEET_COUNT_COLUMNS`
to serve the cohort. That fragment drives the dashboard KPI strip, zone rows, company×plant rows, the
Fleet Directory and Ops Explorer reconciliation. It must be **imported and used**, never modified.
`dashboard-kpi-reconciliation.e2e-spec.ts` (14 tests over the whole database) is the tripwire.

---

## 9. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **Page ships on the uncorrected population** → 39% failure rate published, Operations chases ~2,500 warehouse devices | **High** | Sequence the fix first (Slice 1 blocks the page); reconciliation test asserting cohort totals partition into operational + warehouse |
| R2 | Blank-remark bulk-load rows swamp the operational view (55.1% never-online on 292 rows) | Medium | `remark` filter already exists; needs a **default decision** (§11, D2), plus a visible "unclassified fitments" row rather than a silent exclusion |
| R3 | Someone edits `FLEET_COUNT_COLUMNS` to serve the cohort | **High** | Import-only rule, stated in the issue; `dashboard-kpi-reconciliation` is the tripwire |
| R4 | Calendar-time inactivity series built on `failure_cycles` while 82% of cycles are stuck open (#229) | **High** if built | Explicitly deferred; the shipped trend is the fitment-relative curve, which has no such dependency |
| R5 | Pre-epoch TTFR contamination (median ~8,707 h vs 17.26 h) leaks into a chart | Medium | Already handled — `ttfr_hours` is epoch-gated in SQL and `sampleSize` is reported honestly. The UI must render `null` as "—", never 0 |
| R6 | `prisma migrate dev` regenerates the unique index without `NULLS NOT DISTINCT` | **High** (data corruption) | Pre-existing, already guarded by migration comment + `device-commissioning.e2e-spec.ts`. **No migration is proposed in this plan**, which keeps the exposure at zero |
| R7 | Installer names published next to failure rates read as accusations | Medium | Already handled — 4-class labelling, unresolvable logins shown but **never ranked**. Keep that rule in the UI |
| R8 | The 6.4% multi-fitment devices make a device-level count disagree with the fitment-level card | Low | State the grain on each surface; the drill-through filter is device-grain by construction |
| R9 | `device_commissioning` only accumulates on master-sync runs, which are manual today (`INGESTION_SCHEDULER_ENABLED=false`) | Medium | Surface the last successful sync as a data-as-of chip (the pattern already exists); an operational, not engineering, concern |
| R10 | Local test suite is not a reliable green/red signal (#156 — fixture leakage, no truncation) | Medium | New tests must be unit-level + module-scoped e2e, run in isolation and reported per-file, per #217's precedent (36 DB-free unit tests, deliberately) |

---

## 10. Development slices

Following the repo's issue conventions (`docs/agents/issue-tracker.md`). **Three new issues plus
amendments to #232.** No invented work: every slice below closes something this investigation
measured.

### Dependency / build order

```
  #233  population correctness  ──┬──►  #232 AC-1  the admin page  ──►  #235  drill-through filter
                                  │            ▲
  #234  resolution curve        ──┴────────────┘
                                       (#232 AC-3 kpiCatalog rides with the page)

  deferred, not filed as buildable:  calendar-time inactivity series  →  blocked on #229 running
```

### Slice 1 — **#233** · Commissioning cohort counts the warehouse as failed installs

- **Type:** Defect · Backend-only · AFK · **blocks #232 AC-1**
- **What:** Add a `population` filter to `gradedSource`, defaulting to `operational`
  (`ds.is_departed = false` + `EXCLUDE_DEACTIVATED_PLANTS`), with `all` preserving today's behaviour.
  **Import** the predicates from `dashboard.service.ts`; do not restate them.
- **AC-1** Default `population=operational` on both endpoints; live 90-day totals move
  6,832 → 2,645 fitments and 2,668 → 147 failed.
- **AC-2** `population=all` reproduces today's numbers exactly (regression floor).
- **AC-3** A reconciliation test asserts `operational + warehouse = all` for the same window — the
  §2.8 partition identity, not a second spelling of the predicate.
- **AC-4** The payload reports both counts so the drop is named, per the Fleet Composition pattern.
- **AC-5** `dashboard-kpi-reconciliation.e2e-spec.ts` (14 tests) still green — proof nothing shared moved.
- **UI surfaces:** n/a (backend-only). **Reference:** n/a.
- **Blocked by:** nothing. Size **S**.

### Slice 2 — **#234** · Cohort resolution curve (hours since fitment)

- **Type:** Feature · Backend-only · AFK · feeds #232 AC-1
- **What:** Add hours-since-fitment resolution buckets (`<4, 4–12, 12–24, 24–48, 48–72, >72, never`)
  to the **same** `GROUPING SETS` pass as `count(*) FILTER (…)` columns. No second query, no new
  endpoint, no new table, no job.
- **AC-1** Buckets derive from the **same** `commissioned` expression as the counts — the totals and
  the curve cannot disagree.
- **AC-2** Bucket membership is epoch-gated exactly as `ttfr_hours` is; pre-epoch fitments count in
  `fitments` and in `never`, but contribute to no timing bucket.
- **AC-3** Measured: the extended query stays inside the §7.2 plan (no disk spill, one pass) at
  `cohortDays=90`. Record the EXPLAIN in the completion report.
- **AC-4** Live shape reproduces §3.4 (97.7% inside 48 h).
- **UI surfaces:** n/a (consumed by #232's page). **Reference:** n/a.
- **Blocked by:** #233 (shares `gradedSource`). Size **S**.

### Slice 3 — **#232 AC-1 + AC-3** · The admin surface *(amend the existing issue, do not duplicate)*

- **Type:** Feature · Admin · AFK · **the open parity-gate item**
- **What:** Route `/reports/commissioning`, Analytics nav group, `MANAGER_ROLES`, ZM clamped with the
  `scopedToZoneId` caveat rendered. Composition per §6.1, built from existing primitives; one new
  bucket-bar component.
- **AC-1** Layout, hierarchy and role visibility follow `docs/ui/desktop/v2-reference/21-reports.png`;
  UI-discovery steps in `docs/agents/workflow.md` followed before writing code. Do not redesign.
- **AC-2** Population is visible as a control **and** as a named drop; the default is `operational`.
- **AC-3** Every figure carries a `kpiCatalog.ts` entry rendered through `KpiInfo`, and
  `docs/kpi-definitions.md` is written from the same entries (#232 AC-3).
- **AC-4** `medianHours: null` renders as "—", never 0 (R5); `sampleSize` is shown beside every median.
- **AC-5** Installer rows show `installerKind`; non-`PERSON` kinds are displayed but **never ranked** (R7).
- **AC-6** Page label states the true window ("last 90 days"), per decision D1.
- **UI surfaces:** `Admin: Commissioning cohort (new)` · `Mobile: n/a`.
- **Reference:** `docs/ui/desktop/v2-reference/21-reports.png`.
- **Blocked by:** #233, #234. Size **M**.

### Slice 4 — **#235** · Drill-through: recently-commissioned filter on the device list

- **Type:** Feature · Backend + Admin · AFK
- **What:** One optional `commissionedWithinDays` filter on `GET /api/devices`, and cohort table rows
  linking to `/reports/device?plantId=…&commissionedWithinDays=…`. Closes "drill into individual
  device details" using the existing Device Detail page, its cycles endpoint and its downtime trend.
- **AC-1** Absent param ⇒ byte-identical existing behaviour (regression floor).
- **AC-2** Filter reuses the same `device_commissioning` predicate; it does not restate the cohort
  definition.
- **AC-3** ZM zone clamp holds through the new filter.
- **AC-4** Device-grain vs fitment-grain is stated on both surfaces (R8).
- **UI surfaces:** `Admin: Device Detail list (modified)` · `Mobile: n/a`.
- **Reference:** `docs/ui/desktop/v2-reference/22-device-detail.png`.
- **Blocked by:** #232 AC-1. Size **S**.

### Deliberately **not** filed as buildable

**Calendar-time cohort inactivity series.** Blocked on #229's auto-recovery actually executing
(`INGESTION_SCHEDULER_ENABLED`). Recorded in #234's notes as a follow-up with its precondition stated,
so it is not silently forgotten and not silently built on a distorted source.

---

## 11. Testing strategy & regression protection

Shaped by #156 — **the local full suite is not a reliable green/red signal** (`fsm_test` is never
truncated; 780 orphan zones / 404 orphan engineers measured). Weight the proof accordingly.

| Layer | What it proves | Precedent |
|---|---|---|
| **DB-free unit tests** (bulk of the new coverage) | Bucket boundaries, population predicate composition, null-vs-zero timing, grain arithmetic, installer classification | #217 shipped 36 unit tests over `dataset-query.ts` for exactly this reason |
| **Module-scoped e2e** over the real DI graph and HTTP | Role gating, ZM clamp + `ZONE_SCOPE_VIOLATION`, window `400`s, payload shape | `commissioning-cohort.e2e-spec.ts` (27 tests) — extend it |
| **Partition identity test** | `operational + warehouse = all` for the same window | the §2.8 identity, checked the way `reconciliation.service.ts` checks its six |
| **Untouched-neighbour regression** | `dashboard-kpi-reconciliation.e2e-spec.ts` (14 tests, whole-DB) green ⇒ shared predicates did not move | the tripwire for R3 |
| **Append-only guard** | `device-commissioning.e2e-spec.ts` — `pg_index.indnullsnotdistinct = true` | R6; already exists, must stay green |
| **Live validation** *(new standing rule)* | Each backend slice records real-`fsm` figures in its completion report, not just fixture greens | **this is what caught the defect; AC-2 sat unexecuted for 3 days** |
| **Admin** | `vitest` selector contract (test ids / aria-labels), null-median rendering, role visibility | `apps/admin` 94 files / 442 tests |

**Run per-file and report per-file** — never a bare "full suite green" claim from a local box (#156).

---

## 12. Open decisions requiring your approval

| # | Decision | Options | My recommendation |
|---|---|---|---|
| **D1** | **The window label.** `COHORT_DAYS.max = 90`; "3 months" is 90–92 days (Δ = 14 fitments) | (a) keep 90, label the page "last 90 days" · (b) raise the ceiling to 92 and re-measure the plan | **(a).** The ceiling is a measured performance contract; changing it to satisfy a label is the wrong trade, and 14 fitments change nothing |
| **D2** | **Default population.** Warehouse devices are 64% of the raw cohort and drive the 39% figure | (a) default `operational`, expose `all` · (b) default `all` · (c) operational only, no toggle | **(a).** Matches every other rate on the platform, keeps reconciliation possible, names the drop |
| **D3** | **Blank-remark bulk-load rows.** 2,868 in 90 days, 94.8% never-online when departed; 292 operational at 55.1% | (a) include, shown as a separate "unclassified" row · (b) exclude by default with a visible toggle · (c) include silently | **(a).** They are real fitments; hiding them makes the page disagree with the source. Never (c) |
| **D4** | **Grace window.** `graceHours` default 48 | (a) 48 h · (b) 24 h · (c) 72 h | **(a) 48 h — now confirmed on FSM data**, not just AutoPlant: 97.7% of measured TTFR falls inside 48 h, 99.6% inside 72 h |
| **D5** | **Is "installer" a unit of accountability you want on a management screen?** Logins resolve to no user master; ~74% populated; one login shows 97.5% failure | (a) show, labelled, never ranked *(built)* · (b) plant/vendor only, drop the installer table · (c) show and rank | **(a) — the built behaviour.** This is a business call, not an engineering one, and it is the one you flagged in the feasibility read's §10 Q2/Q3 |
| **D6** | **Deferred calendar-time series.** Blocked on #229 auto-recovery running | (a) defer, note the precondition · (b) build now on `failure_cycles` anyway · (c) build a new daily snapshot table | **(a).** (b) publishes an artefact; (c) is the unnecessary table this brief asked to avoid |

---

## 13. Summary of required changes

| # | Change | Kind | New table? | New job? | Blast radius |
|---|---|---|---|---|---|
| 1 | `population` filter on `gradedSource`, default operational, predicates **imported** | Backend fix | No | No | Zero — nothing consumes these endpoints yet |
| 2 | Resolution buckets on the existing `GROUPING SETS` pass | Backend, additive | No | No | Same query, same plan |
| 3 | `/reports/commissioning` admin page + nav + API client + `kpiCatalog` entries | Frontend | No | No | New route only |
| 4 | Optional `commissionedWithinDays` on `GET /api/devices` | Backend, additive | No | No | Absent param ⇒ identical behaviour |

**No migration. No schema change. No new index. No new cron. No AutoPlant query change. No writer.**

---

## Appendix — provenance

All queries read-only. Working scripts in the session scratchpad, not committed.

| § | Source | Objects |
|---|---|---|
| 1.5, 3.1–3.5, 7.2 | FSM Postgres `localhost:5433/fsm`, live, 2026-08-13 | `device_commissioning`, `device_states`, `plants`, `tickets`, `failure_cycles`, `master_sync_runs`, `pg_index`, `pg_class`, `EXPLAIN ANALYZE` |
| 1.2, 1.3 | quoted, not re-measured | `audit/commissioning-view-feasibility.md` §1–§2 (AutoPlant production) |
| 2, 4, 6, 8 | repo | `commissioning-aggregation.service.ts`, `commissioning.config.ts`, `installer-classification.ts`, `reports.controller.ts`, `dashboard.service.ts`, `devices.controller.ts`, `master-sync.service.ts`, `20260809120000_device_commissioning/migration.sql`, `AppRoutes.tsx`, `components/shell/nav.ts`, `lib/kpiCatalog.ts` |
| 5 | repo + live | `SYSTEM-STATE-2026-07.md` §2.9/§3d, `partition-planner.ts`, `soft_inactive_count_history`, `device_downtime_summary_monthly`, `failure_cycles` |
