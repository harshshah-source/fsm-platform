# Commissioning window & install-quality view — feasibility assessment

**Date:** 2026-08-09 · **Mode:** read-only investigation. No source, schema, sync or data changes were made.
**Sources:** AutoPlant production MySQL (`ap_widgets`, `ap_masters`, user `bi_enroute_readonly`, SELECT-only)
and FSM Postgres `localhost:5433` (dev instance; device data is a real AutoPlant mirror — see caveat §0).
**Related:** [#223](../.scratch/fsm-platform-v1/issues/223-ndd-counted-healthy.md) ·
[#222](../.scratch/fsm-platform-v1/issues/222-telemetry-staleness.md) ·
[#226](../.scratch/fsm-platform-v1/issues/226-null-gps-over-real-telemetry.md) ·
[#217](../.scratch/fsm-platform-v1/issues/217-operations-data-explorer.md)

---

## Verdict

**Yes — but the premise needs correcting first, and one thing must be captured now or it is lost forever.**

Three findings, in order of how much they change the shape of the idea:

1. **A normal install comes online within 24 hours — not seven days.** For genuine new
   installations, 96.97% are reporting by the 12–24 h mark, and the curve is flat from there
   (98.53% at 2–3 days, 95.61% at 3–7 days — the wobble is sampling noise, not a rising trend).
   There is essentially **no commissioning tail**. A device that has not reported within 24 hours
   of fitment is not "still commissioning"; it is overwhelmingly likely to be broken. This inverts
   the framing in the brief: fitted devices are *not* "expected to be silent for a while."

2. **AutoPlant does know who did the installation — `FIRST_INSTALLED_BY` — and the field is
   getting rapidly better.** It is not the column you expected: `FIRST_INSTALLED_COMPANY_ID` is
   **not** an installing party, it is the owning company, in 62,992 of 62,992 rows with zero
   exceptions. But `FIRST_INSTALLED_BY` holds a real per-technician login identity, and its
   unusable-`NA` rate has fallen from 100% (2021) to **12.9% (2026)**.

3. **"Time to first report" is not computable retrospectively and will not become computable by
   waiting.** FSM stores no first-GPS timestamp, and the raw telemetry table's default retention
   is 7 days by whole-partition `DROP TABLE`. The moment a device first reports is observable
   exactly once, as it happens. **This is the one part of the idea that cannot be derived and must
   be stored.**

The view is worth building, at moderate cost, mostly for the install-quality measure rather than
for the grace period. §11 sets out the case against.

---

## 0. Caveat on the numbers

Two independent halves, and this assessment is careful about which it is standing on:

- **AutoPlant production figures are real.** Every measurement in §§1–2, §5 and §8 was taken
  directly from `ap_widgets.tb_vehiclemaster` / `ap_masters.mst_vehicle_log` on production.
- **FSM figures come from the local dev Postgres**, whose device mirror is genuine AutoPlant data
  but whose org/ticket data is seeded. Only device-level facts are cited from it (§3, §6).
- **The 5.5 h ingest offset (#222) does not contaminate the install-duration measurement.** The
  survival curve is computed entirely source-side, comparing `FIRST_INSTALLED_DATE_TIME` against
  `latest_gps_datetime` and `UTC_TIMESTAMP()` within MySQL. It never touches an FSM-stored
  timestamp. All datetimes were fetched as formatted strings so neither driver applied a timezone
  conversion.

---

## 1. Does AutoPlant know who did the installation?

**Yes — via `FIRST_INSTALLED_BY`. And `FIRST_INSTALLED_COMPANY_ID` is definitively not it.**

### 1.1 `FIRST_INSTALLED_COMPANY_ID` is the owning company, not an installer

This is settled, not inferred:

| Test | Result |
|---|---:|
| Rows where `FIRST_INSTALLED_COMPANY_ID` = the company prefix of `hierarchy_path` | **62,992** |
| Rows where it differs | **0** |

It carries 35 distinct values which map one-to-one onto the tenant companies (`1004` = 25,308
devices across 22 plants, `1000` = 20,927 across 107, and so on). It answers "whose fleet is this",
which FSM already knows. **Discard it as an attribution candidate.**

### 1.2 `FIRST_INSTALLED_BY` is genuine installer attribution

100% populated (62,992/62,994), 183 distinct values fleet-wide. The values are per-site technician
logins in a consistent `SITE_PERSON` or `SITE_SERVICE` convention:

```
VICAT_KADAPA_SERVICE  3637     CHITTOR_NARAYAN  1604     RISDA_DEEPAK   1148
RISDA_DURGESH         2289     CHITTOR_VINOD    1576     UTCL_SERVICE_DEPOT_CBT 1068
PRISM_IVTS            1950     RCP_AJIT         1493     NIMBOL_KARAN    770
```

There is **no user master to resolve these against** — a search of `ap_masters`/`ap_widgets` for any
user/employee/login table returns nothing. It is a free-text login string. For grouping and
ranking that is sufficient; for showing a human name or contacting anyone, it is not.

### 1.3 Population quality — and the reason this is now worth doing

The field was useless when it was introduced and is close to usable now:

| Install year | Devices | `NA` | Machine accounts | **Real named installer** | Distinct |
|---|---:|---:|---:|---:|---:|
| 2021 | 242 | 100.0% | 0 | **0.0%** | 1 |
| 2022 | 480 | 99.2% | 0 | **0.8%** | 2 |
| 2023 | 1,695 | 90.0% | 1 | **9.9%** | 17 |
| 2024 | 3,741 | 82.3% | 240 | **11.3%** | 16 |
| 2025 | 38,097 | 36.6% | 2,817 | **56.0%** | 120 |
| **2026** | **18,732** | **12.9%** | 1,309 | **80.1%** | 131 |

Last 90 days: 8,252 installs, 105 distinct installers, 162 plants, 17.4% `NA`.

**This is the single strongest argument for building the view now rather than a year ago.** A
retrospective install-quality report would have been mostly `NA`. A prospective one is 80%
attributable and improving.

### 1.4 The confound that will bite — machine accounts

Not every value is a person. `INTEGRATION_SERVICE`, `SERVICE-ACCOUNT-INTEGRATION-SERVICE`,
`SERVICE-ACCOUNT-EPOD-SERVICE`, `*_IMPADMIN` and `*_ADMIN` are bulk-provisioning identities that
fire across dozens of plants at once. They are **heavily over-represented in the failure
population**: `INTEGRATION_SERVICE` shows 298 installs across 49 plants with a 45.0% never-online
rate, and in the live 7-day cohort it is the sole "installer" at 14 of the 20 worst plants.

Left unfiltered, an install-quality leaderboard will mostly report that a service account is bad at
installing things, which is not actionable. The view needs an explicit
person-vs-machine classification, and that classification does not exist in the source — it would
be an FSM-side pattern list, and therefore a maintenance liability.

### 1.5 There is also install-*type* attribution, which nobody has been using

`INSTALLATION_REMARK` (68.4% populated) and `INSTALLATION_SUBREMARK` (78.1%) carry a clean
controlled vocabulary, and it **predicts failure strongly**:

| Remark | Subremark | Devices | Never reported | NDD % |
|---|---|---:|---:|---:|
| New Installation | New Device | 2,931 | 92 | **3.14%** |
| Re-Installation | New Device | 960 | 16 | **1.67%** |
| Re-Mapping | Same Device | 33,040 | 1,625 | 4.92% |
| Re-Installation | Replacement Device | 5,548 | 307 | 5.53% |
| *(blank)* | *(blank)* | 13,788 | 3,781 | **27.42%** |

The blank-remark population is the legacy/bulk-loaded backlog and carries an NDD rate 8× the
genuine-new-install rate. **This field is a better cohort filter than any date arithmetic** — see
§5.3.

---

## 2. Is the fitment date good enough to build on?

**Yes for quality, with one important semantic correction: it is not "first ever fitted", it is
"first fitted to this vehicle", and it is rewritten on re-mapping.**

### 2.1 Coverage and hygiene across the whole source (not just the NDD population)

| Check | Result |
|---|---:|
| Rows in `tb_vehiclemaster` | 62,994 |
| `FIRST_INSTALLED_DATE_TIME` populated | **62,987 (99.99%)** |
| NULL | 7 |
| Pre-2000 | **0** |
| Epoch-zero | **0** |
| Future-dated | **0** |
| Exact-midnight (date-only masquerading as timestamp) | **0** |
| Range | 2021-02-11 → 2026-08-09 (today) |

This is materially cleaner than the #223 sample suggested, and it holds fleet-wide, not just on the
907. **No placeholder pattern, no sentinel values, no future dates.**

Two blemishes worth recording rather than worrying about:

- **Bulk-write bursts.** Clusters such as `2025-07-30 17:25:27`–`:40` carry 50–63 devices *per
  second*. These are migration writes, not fitments. They matter for historical analysis and are
  irrelevant prospectively.
- **An IST-midnight signature.** A small number of values land on exactly `05:30:00` (= 00:00 IST),
  e.g. `2023-02-04 05:30:00` on 87 rows — date-only entries converted from IST. Confined to
  2023-era rows.

### 2.2 Stability — the field IS rewritten, and this is the finding that matters most in §2

Measured against `mst_vehicle_log` (805,554 change rows over 81,539 devices):

| | |
|---|---:|
| Devices with log history | 81,534 |
| **Devices where `first_installed_dt` changed** | **10,565 (12.96%)** |
| …moved by more than 30 days | 8,110 |
| …moved by more than a year | 1,757 |
| Max distinct values for one device | 182 |
| Devices where `first_installed_by` also changed | 5,929 (7.28%) |

A worked example makes the mechanism unambiguous — one device across five vehicles:

| `first_installed_dt` | `first_installed_by` | vehicle | remark |
|---|---|---|---|
| 2025-04-29 19:18 | maheswar_mahato | RJ09GD2427 | — |
| 2025-06-01 18:46 | vikash_upadhayay | JH12P1800 | — |
| 2025-07-10 19:00 | NA | CG07BS4127 | — |
| 2025-10-03 22:53 | VIKASH_UPADHAYAY | JH02BP1351 | Re-Mapping / Replacement Device |
| 2025-10-26 09:07 | VIKASH_UPADHAYAY | HR55AU0820 | Re-Mapping / Replacement Device |

**`FIRST_INSTALLED_DATE_TIME` means "when this device was first fitted to *this vehicle*".** The row
grain is the vehicle (`tb_vehiclemaster` is keyed on `vehicle_no`; 83,547 distinct vehicles vs
81,539 devices in the log).

For the commissioning use case this is **semantically correct, not a defect** — a device moved to a
new vehicle genuinely is a new commissioning event that should be verified. But it has a hard
consequence:

> **A re-map overwrites the previous commissioning record in place. The source cannot tell you how
> the *previous* fitment went, because that history is gone from `tb_vehiclemaster` the moment it
> is rewritten.** Any install-quality measure that reads only the current source row is measuring a
> silently-mutating population.

This is the evidence that decides the architecture — see §7.2.

### 2.3 Alternative anchors, compared

| Column | Populated | Verdict |
|---|---:|---|
| **`FIRST_INSTALLED_DATE_TIME`** | **99.99%** | **Best available anchor.** Use it. |
| `LATEST_INSTALLATION_DATE_TIME` | 99.41% | Tracks the most recent re-map. Useful as a *change detector*, not an anchor. |
| `TRIP_CREATION_DATETIME` | 86.26% | Not an install anchor — **17,634 rows have a trip predating the install date** (the vehicle existed before this device). |
| `SIGNAL_RECEIVED_TIME` | 38.13% | **Useless.** Exactly equal to `latest_gps_datetime` in all 24,017 populated rows — a duplicate column, not a first-signal marker. |
| `device_installation_date` | 36.87% | Too sparse. |
| `VEHICLE_MAPPING_DATE` | 35.32% | Too sparse. |
| `RECORD_CREATED_DATE` / `insertion_datetime` | 36.49% / 39.36% | Mirror-row bookkeeping. |
| `CREATED_DT` | **0%** | Empty. |

`mst_vehicle.first_installed_dt` agrees (51,137/51,142 populated) and remains a valid cross-check.

### 2.4 A trap in the obvious query

The naive measurement `latest_gps_datetime − FIRST_INSTALLED_DATE_TIME` is **negative for 46.27%**
of devices installed in 2026 (8,091 of 17,485). That looks like a data disaster; it is not. Split
by remark:

| Remark | Devices | GPS predates install | % |
|---|---:|---:|---:|
| *(blank)* | 5,947 | 5,762 | **96.9%** |
| Re-Mapping | 8,238 | 2,254 | 27.4% |
| New Installation | 2,298 | 74 | **3.2%** |
| Re-Installation | 1,000 | 1 | 0.1% |

It is almost entirely the blank-remark legacy population plus re-maps, where the recorded "first
install" date post-dates telemetry the device produced on a *previous* vehicle. On genuine new
installations the anomaly nearly vanishes. **Anyone computing install duration without filtering on
`INSTALLATION_REMARK` will get a meaningless answer.**

---

## 3. Can FSM measure "time to first report" at all?

**Not today, not retrospectively, and not by waiting. But prospectively it is nearly free — one
column and one `COALESCE`.**

### 3.1 Nothing stores a first-ever timestamp

- `device_states` holds `latest_gps_datetime` and `trip_creation_datetime`, both advanced with
  `GREATEST` (`snapshot-ingestion.service.ts:121-122`) — they can only move forward and structurally
  cannot record an origin.
- `devices` has `created_at`/`updated_at` only, and `created_at` is the FSM mirror date, not the
  fitment date. Measured on the dev DB: **every one of the 26,543 devices was created in 2026-06
  (24,840) or 2026-07 (1,703)**, i.e. when the mirror was first populated. Worthless as a proxy.
- No `installed_at`, `commissioned_at` or `first_seen_at` exists anywhere in the schema.
- The only first-ping logic in the codebase is transient: `install-lifecycle.service.ts:185-189`
  reads the earliest snapshot after an anchor, uses it to close an install ticket, and **discards
  the timestamp**.

### 3.2 The raw telemetry table cannot be mined for it

Two independent reasons, both fatal:

1. **Never-reported devices are excluded from ingestion entirely.**
   `autoplant-source-reader.ts:87-90`:
   ```sql
   SELECT ... FROM tb_vehiclemaster
   WHERE latest_gps_datetime IS NOT NULL AND device_id IS NOT NULL AND TRIM(device_id) <> ''
   ```
   A device that has never reported produces no row, ever. FSM cannot observe the NULL→non-null
   transition from telemetry, because the pre-transition state is invisible to it.

2. **Retention destroys the evidence.** `raw_device_snapshots` is daily-range-partitioned and
   `partition-maintenance.service.ts:97-100` runs `DROP TABLE` on partitions older than
   `telemetry_retention_days`, **default 7** (`partition-planner.ts:18`). Even if the first-report
   row were written, it would be dropped within a week.

The dev DB looks superficially encouraging — 1,652,199 rows over 58,501 devices spanning
2023-03-15 → 2026-08-07 — but this is an artefact and must not be mistaken for history. The
`gps_datetime` column carries the *source's* `latest_gps_datetime`, so a device whose last ping was
in 2023 lands in the 2023 range; the 255 MB `raw_device_snapshots_default` partition is holding all
of it. FSM itself has only 118 snapshot runs, spanning 2026-07-07 → 2026-08-07 — **one month**. And
58,500 of 58,501 devices have their earliest row at the very start of that window, i.e. it records
when FSM started looking, not when the device started reporting. Partition maintenance is
additionally gated off by default (`PARTITION_MAINTENANCE_ENABLED`), which is why 52 partitions
survive here — configuration accident, not a retention guarantee.

### 3.3 Prospectively, it is one line

Because the source reader excludes NULL-GPS devices, **the first row a device ever receives in
`raw_device_snapshots` is, by construction, its first report** — accurate to the 30-minute telemetry
sweep (`INGESTION_TELEMETRY_CRON`, default `*/30 * * * *`). The capture point already exists. The
`device_states` upsert at `snapshot-ingestion.service.ts:114-123` already does exactly this shape of
write:

```sql
ON CONFLICT (device_id) DO UPDATE
  SET latest_gps_datetime = GREATEST(device_states.latest_gps_datetime, EXCLUDED.latest_gps_datetime),
      ...
```

Adding a write-once companion is symmetric and costs one clause:

```sql
      first_reported_at = COALESCE(device_states.first_reported_at, EXCLUDED.latest_gps_datetime),
```

`COALESCE` (rather than `LEAST`) makes it write-once and immune to backfill reordering.

### 3.4 The answer differs for historical vs new devices — and the difference is the design

| | Historical devices | Devices fitted after this ships |
|---|---|---|
| Time to first report | **Unrecoverable.** Not in the source, not in FSM, not derivable. | **Measurable to ±30 min.** |
| Fitment date | Available, but rewritten on re-map (§2.2) | Captured at the event |
| Installer | 12.9%–36.6% `NA` depending on era | ~80% attributable and improving |

**The view can only ever work prospectively.** As §9 shows, that is not a limitation to work around
— it is the mechanism that solves the historical-backlog problem for free.

---

## 4. Where does this fit in the existing architecture?

### 4.1 Closest analogues

| Surface | Fit | Why |
|---|---|---|
| **Fleet Directory** (`dashboard.service.ts:526`, `FleetDirectoryPage.tsx`) | **Closest by shape** | Already produces per-plant rows with a `COUNT(*) FILTER (...)` numerator over an operational denominator, and `withRates()` (`:76`) derives a null-safe percentage. This is exactly the cohort-with-denominator arithmetic, one grouping key away. |
| **Activity Trend** (`dashboard.service.ts:855`, `ActivityTrendSection.tsx`, `FleetActivityTrendChart.tsx`) | **Closest by time handling** | Range picker (1D/7D/1M/1Y/MAX), `date_trunc` bucketing from a whitelisted literal, sparse-series recharts `LineChart`. |
| **Fleet Composition funnel** (`dashboard.service.ts:440`) | Conceptual precedent | A denominator chain with each drop named — but point-in-time, no time axis, rendered as metric cards. |
| **Ops Explorer** (`dataset-registry.ts`) | **Does not fit** — see below | |

**Nothing joins the first two.** No endpoint groups by plant *and* filters by a fitment window, and
nothing anywhere computes time-to-event or percentiles (`percentile_cont`, `NTILE`, `width_bucket`:
zero hits across `apps/backend/src`).

### 4.2 Could this be an Ops Explorer dataset instead of a page? No.

This was the most attractive option and it does not survive contact with the code.
`buildDatasetQuery` (`dataset-query.ts:348-395`) emits exactly one statement shape —
`SELECT … FROM … WHERE … ORDER BY … LIMIT` — plus a `COUNT(*)`. There is **no `GROUP BY`, no
`HAVING`, no window function and no aggregate clause in the builder**, and `DatasetQueryRequest`
has no `groupBy`, `aggregate` or bucket field.

The only aggregation escape hatch is baking a correlated scalar subquery into a column's `sql`, as
`plants.activeDeviceCount` does (`dataset-registry.ts:1057`). That would work — but the cohort
window would be **hard-coded into the registry SQL**, because filters bind values into `WHERE` and
cannot parameterise a column expression. A "last N days" control would be impossible; you would
ship `devicesFittedLast7d` as a frozen column and that is the product.

The precedent is decisive: `reconciliation.service.ts` needed real aggregation and **escaped the
registry entirely** onto its own `@Get('reconciliation')` endpoint. This would too.

### 4.3 Frontend precedent for cohort / distribution views

`recharts ^2.15.4` is present and is the only charting library. Existing components:
`TrendChart`, `FleetActivityTrendChart`, `BarChartCard`, `SlaBucketBarChart`, `DonutChart`,
`RadialGauge`, `DistributionBar`, `BarList`.

**There is no histogram, no binned-distribution, no funnel, no cohort/retention grid, no boxplot and
no scatter.** `SlaBucketBarChart` and `DistributionBar` are named "distribution" but plot
pre-bucketed categorical counts (the 8 SLA enum bands), not a computed numeric distribution. A
time-to-first-report histogram **would be the first of its kind** — though it is a bar chart over
pre-computed buckets, so "first of its kind" means a new component, not a new capability.

Page registration itself is cheap: one import + one `<Route>` in `AppRoutes.tsx`, one entry in the
`Analytics` group in `nav.ts:114-119`, one typed fetcher. **The expensive part is the backend
aggregation, not the frontend.**

### 4.4 Backlog — what you would be duplicating

250 issue files; highest is #228. The relevant overlap:

- **#223 already owns most of this conceptually.** It proposes `devices.installed_at` mirrored from
  `FIRST_INSTALLED_DATE_TIME` (`:180`, `:242`); its **P2** is precisely the grace-window question;
  it names the `COMMISSIONING` state explicitly (`:260`) in a proposed
  `REPORTING | SILENT | COMMISSIONING | NEVER_REPORTED` enum; and it identifies install-quality
  ownership (`:151-153`, `:264`). **Filing a new issue without reconciling against #223 would
  duplicate it.**
- **#34** (`done`) already implements per-*ticket* first-ping waiting → `CLOSED` or
  `FAILED_ACTIVATION`. It does not persist the timestamp and is per-install-ticket, not per-device.
- **#222 / #226** are correctness prerequisites for any figure computed from FSM-stored GPS.
- **#40, #39, #44, #134, #217** are the existing trend/report surfaces — all zone/company/plant
  keyed, **none install-cohort keyed**.
- **#148:87** explicitly rejected a grace-period design in the sweep layer. Different subject, but
  worth reading before proposing another one.

**Genuinely uncovered ground:** installer identity capture (no field anywhere in FSM) and
cohort-keyed reporting.

### 4.5 What this needs from #223, and what it needs beyond it

| Needs from #223 | Status |
|---|---|
| `devices.installed_at` mirrored from `FIRST_INSTALLED_DATE_TIME` | In #223's minimum viable change, step 1 |
| Reading the AutoPlant master columns at all | #223 establishes the ingestion change; FSM reads none of them today |
| A defensible NDD definition | #223 P1 decided (never-reported = fault) |

| Needs beyond #223 | Cost |
|---|---|
| `first_reported_at` capture | One column + one `COALESCE` (§3.3) |
| `installed_by` + `installation_remark` mirrored | Two more columns on the same sync |
| An immutable per-fitment record (§7.2) | Small table + write-on-change |
| Cohort endpoint + page | The bulk of the work |

---

## 5. The window length — measured, not assumed

**This is the number that decides the design, so it is stated three ways.**

### 5.1 Method

Time-to-first-report is not directly recorded anywhere (§3), so it was measured as a
**cross-sectional survival curve**: for devices fitted *H* hours ago, what fraction have ever
reported? This reads the CDF straight off the fleet without needing any first-report timestamp, and
is valid given roughly steady install volume — which §5.4 confirms.

### 5.2 The curve — genuine new installations (`INSTALLATION_REMARK = 'New Installation'`)

| Age since fitment | Devices | Online | **% online** |
|---|---:|---:|---:|
| < 12 h | 6 | 4 | 66.67% |
| **12–24 h** | 33 | 32 | **96.97%** |
| 1–2 d | 54 | 52 | 96.30% |
| 2–3 d | 68 | 67 | **98.53%** |
| 3–7 d | 114 | 109 | 95.61% |
| 7–14 d | 203 | 199 | 98.03% |
| 14–30 d | 186 | 185 | 99.46% |
| 30 d+ | 2,267 | 2,191 | 96.65% |

### 5.3 The same curve, all real field installs (machine accounts excluded), 2026 installs

| Age since fitment | Devices | Online | **% online** |
|---|---:|---:|---:|
| < 4 h | 8 | 5 | 62.50% |
| 4–12 h | 7 | 7 | 100.00% |
| 12–24 h | 56 | 48 | 85.71% |
| 1–2 d | 103 | 95 | 92.23% |
| 2–3 d | 140 | 138 | **98.57%** |
| 3–7 d | 404 | 384 | 95.05% |
| 7–14 d | 621 | 595 | 95.81% |
| 14–30 d | 1,315 | 1,284 | 97.64% |
| 30 d+ | 13,178 | 12,513 | 94.95% |

### 5.4 Reading it

- **The asymptote is ~95–97%, and it is reached between 24 and 72 hours.** Everything past that
  point is flat within sampling noise (the sub-12 h buckets have n < 10 and should be ignored).
- **Median time to first report is well under 24 hours** — probably a few hours, but the sweep
  granularity is 30 minutes and the sub-day buckets are too thin to state a median honestly. What
  *can* be stated with confidence is the shape: by 24 h the cohort is ~86–97% resolved; by 72 h it
  is at its asymptote.
- **The residual ~3–5% are not slow, they are broken.** They never come online at any horizon —
  the 30 d+ bucket is no better than the 2–3 d bucket.

> **A 7-day window is not merely "generous and safe" — it is roughly 3× longer than the phenomenon
> it is meant to accommodate.** It would delay detection of a genuinely failed install by four to
> five days for no measured benefit.

**Recommendation: 48 hours.** It sits past the 2–3 day knee where the curve flattens, it is
comfortably clear of the 24 h bucket's residual noise, and it halves detection latency versus
seven days. 72 hours is defensible if a wider margin is wanted. Seven days is not supported by the
data.

Note the convenient consequence: #223's observation that the existing 24 h
`inactivity_threshold_hours` gives a grace window "for free" turns out to be **well-calibrated by
the data rather than lucky** — 24 h captures ~86–97%. A dedicated 48 h install-grace setting buys a
few percentage points of false-alarm reduction; it is a refinement, not a prerequisite.

**Caveat, stated plainly:** cross-sectional inference assumes install volume and failure behaviour
are roughly stationary across the window. §5.5 shows volume is *not* perfectly stationary — there
are 1,000+/day migration spikes. The curve above is computed over 2026 installs and filtered to
real installers/new installations precisely to suppress those, but a proper cohort-tracked
measurement (available only once `first_reported_at` exists) would supersede it.

### 5.5 Cohort size — is a live view readable?

Live 7-day cohort at time of measurement: **958 fitted · 784 online (81.8%) · 174 silent · 94 plants
· 46 installers.** Daily volume over the last three weeks ranges 13–445 with a typical day near
100. Recent days carry most of the silence (48, 54, 43 silent on Aug 6/7/8) and it decays to near
zero by a week back — the survival curve, visible directly as a daily strip.

That is a readable surface: a few hundred rows, ~100 plant groups, and a signal that visibly
resolves over days.

---

## 6. Does the install-quality measure actually reveal anything?

**Yes — the variance is large and one outlier is glaring.**

Install-failure rate by installer, last 180 days, n ≥ 30:

| Installer | Installs | Never online | **Fail %** | Plants |
|---|---:|---:|---:|---:|
| **PRATIK PAWAR** | 79 | 77 | **97.5%** | 4 |
| INTEGRATION_SERVICE *(machine)* | 298 | 134 | 45.0% | 49 |
| GB_BOKARO | 46 | 19 | 41.3% | 2 |
| DEEPAK_IMPADMIN *(machine)* | 55 | 15 | 27.3% | 6 |
| UTCL_SERVICE_MCU | 94 | 17 | 18.1% | 2 |
| GGVL_SERVICE | 183 | 28 | 15.3% | 1 |
| … | | | | |
| VICAT_KADAPA_SERVICE | 3,117 | 148 | 4.7% | 1 |
| VIKASH_UPADHAYAY | 295 | 9 | 3.1% | 1 |
| ADANIRMC_ADMIN | 172 | 5 | 2.9% | 24 |

Across 61 installers with n ≥ 30 (16,228 installs): **mean 7.59%, range 0.0–97.5%, σ = 14.74 pp.**

By plant, same window: DSTL K1PLANT **69.2%** (117 installs), RCM 30.5% (220), MCU 27.2% (125),
against a long tail at 5% or below.

**`PRATIK PAWAR`: 79 installs, 77 never online.** Whatever that is — a mis-scoped account, a faulty
device batch, a technician who needs retraining, or a data-entry artefact — nobody has noticed it,
and the view's entire value proposition is that it would have surfaced on the first render. That
single row is the strongest argument in this document for building the thing.

---

## 7. Architectural recommendation

### 7.1 Where I agree with you

- **No new module — strongly agree.** These are the same rows in `device_states` plus columns the
  master sync already has to touch for #223. A parallel ingestion/state/eligibility path would
  recreate the `is_departed`/`vehicles.status` drift exactly as you fear.
- **New page — agree, and it is cheaper than it looks.** Ops Explorer genuinely cannot express it
  (§4.2), so a bespoke endpoint is forced. But the page is a composition of two proven shapes —
  Fleet Directory's per-plant numerator/denominator table and Activity Trend's range picker — not a
  novel surface. The audience argument is also right: "which vehicles need me today" and "did last
  week's fitments come online" are different people with different cadences.
- **Cohort membership derived, not stored — agree.** A device fitted 6 days ago becoming one fitted
  8 days ago must not require anything to move. A predicate on a date is correct.

### 7.2 Where I disagree — and it is the most important point in this assessment

> **"Derived, not stored" is right for the cohort label and wrong for the outcome. Two facts must be
> stored, because they are unobservable after the moment they occur.**

**First: `first_reported_at`.** It is not in the source at all, and FSM's own telemetry history is
dropped after 7 days (§3.2). If it is not written when the ping arrives, the number the whole view
exists to report is gone permanently. There is no later query that recovers it.

**Second: the fitment record itself.** §2.2 established that `FIRST_INSTALLED_DATE_TIME` and
`FIRST_INSTALLED_BY` are **rewritten in place on re-mapping** — 12.96% of devices have already had
the date moved, 7.28% the installer. A view that derives everything from the live source row is
therefore measuring a population that silently rewrites its own history: a device that failed
commissioning in June and was re-mapped in July presents as a July install, and June's failure —
along with the name of whoever performed it — simply ceases to exist. **You cannot build a
trustworthy install-quality measure on a mutable source row.**

**But this does not contradict your instinct, it refines it.** Your concern is that a stored
*state* can desynchronise from the date that defines it. That concern is correct and I would apply
it strictly. What is needed here is not a state — it is an **immutable fact**, appended once when
an event is observed and never updated:

```
device_commissioning        -- one row per (device, vehicle, fitment) — append-only
  device_id, vehicle_id
  installed_at              -- FIRST_INSTALLED_DATE_TIME at the moment of observation
  installed_by              -- FIRST_INSTALLED_BY, ditto
  installation_remark       -- the cohort filter that actually matters (§1.5, §2.4)
  plant_id, company_id      -- denormalised at fitment; plants get reassigned too
  first_reported_at         -- written once, by COALESCE, when the first ping lands
  observed_at
```

A fact table has none of the drift risk of a state machine: there are no transitions, nothing to
keep in step, and no way for it to disagree with a date because it *is* the date, as it stood when
the event happened. Cohort membership stays derived — `installed_at >= now() - N days` — exactly as
you wanted. Time-to-first-report is then `first_reported_at − installed_at`, a subtraction of two
stored facts rather than an unrecoverable inference.

This also makes the re-map case correct rather than merely tolerable: a re-map appends a *new* row,
so both commissioning events are measured and neither erases the other.

### 7.3 Cost

Assuming #222 and #223 have landed (see §8):

| Work | Size | Notes |
|---|---|---|
| Mirror `installed_by`, `installation_remark` on the master sync | **XS** | #223 already adds `installed_at` and the read path; these ride along |
| `first_reported_at` capture | **XS** | One column + one `COALESCE` in the existing `device_states` upsert (`snapshot-ingestion.service.ts:114-123`) |
| `device_commissioning` fact table + append-on-change | **S** | Written by the master sync when a fitment is first seen or `installed_at`/`vehicle` changes |
| Cohort endpoint (per-plant, per-installer, window param, bucket histogram) | **S–M** | Bespoke service on the `dashboard` or a new controller; Fleet Directory's aggregate shape + Activity Trend's range handling |
| Person-vs-machine installer classification | **S** | Pattern list; a maintenance liability (§1.4) |
| Admin page | **M** | Composes existing primitives; one new bucket-histogram component |
| **Total** | **M–L** | A useful v1 (plant-grouped cohort, no installer breakdown, no histogram) is **S–M** |

**The XS items are urgent in a way the rest is not.** `first_reported_at` costs almost nothing and
every day it is not shipped is a day of permanently unmeasurable installs. It is worth landing with
#223 even if the page is never built.

---

## 8. Blocked on #223 vs independent

| Blocked on #223 | Why |
|---|---|
| `installed_at` on `devices` | #223 owns the master-sync read of `FIRST_INSTALLED_DATE_TIME`; FSM reads none of these columns today |
| Any cohort *definition* | Needs the mirrored date |
| Consistency of "came online" with the fleet KPIs | #223 changes what `healthy` means; a cohort view shipped first would contradict the dashboard |

| Independent of #223 | Why |
|---|---|
| **`first_reported_at` capture** | Touches only the snapshot-ingestion upsert. **Ship this first, regardless.** |
| The `device_commissioning` table | Master-sync-side; #223's column is a convenience, not a dependency |
| Installer classification | Pure data work |
| Frontend component work | Nothing to block on |

**Also gating the numbers, not the build:** #222 (every stored GPS timestamp is 5.5 h early) and
#226 (15 devices FSM holds as null-GPS have telemetry at source). Neither blocks the *capture* work
— `first_reported_at` inherits whatever offset ingestion applies and self-corrects when #222 lands,
as long as it is written before then. But no *published* commissioning figure should precede #222.

---

## 9. The historical backlog — solved by construction

You asked how to separate the 602 year-old devices from new installs. **The fact-table design does
this without a suppression rule.**

`device_commissioning` only ever gains rows for fitments observed *after* it ships. A device fitted
in 2024 has no commissioning row and no `first_reported_at`, so it is not in any cohort, cannot be
overdue, and cannot generate an alert. The cohort view is prospective by construction — precisely
because the data to build it retrospectively does not exist (§3).

The historical population is therefore **#223's problem, not this view's** — and #223 already has
the right instruments for it: its Q2 (should the >1-year cohort be ticketed at all) and its
recommended operator-gated staged backfill. There is no alert storm here because there is nothing
for the cohort view to alert on.

For the record, the backlog split fleet-wide by install age:

| Install age | Devices | Never reported | NDD % |
|---|---:|---:|---:|
| ≤ 2 d | 344 | 104 | 30.23% |
| 3–7 d | 625 | 70 | 11.20% |
| 8–30 d | 2,513 | 94 | **3.74%** |
| 31–90 d | 4,776 | 421 | 8.81% |
| 91–365 d | 23,261 | 1,821 | 7.83% |
| **> 1 y** | **31,468** | **3,903** | **12.40%** |

The ≤2 d bucket at 30% is the commissioning curve mid-flight, not a defect rate. The >1 y bucket at
12.4% is the real backlog — and note it is **3,903 devices at source**, not 602. #223's 602 counts
only devices FSM currently mirrors as non-departed NDD; the source-side population of long-dead
fitments is six times larger. That gap is worth understanding before anyone sizes a remediation
programme, and it may belong to #227 (orphaned mirror rows).

---

## 10. Open questions

**Only you can answer these:**

1. **Window length: 48 h, 72 h, or something else?** The data says the curve flattens between 24
   and 72 h and that 7 d is ~3× too long. I recommend 48 h. This is a business tolerance, not a
   measurement.
2. **Is "installer" the right unit of accountability, or is it plant/vendor?** Attribution is
   ~80% complete for 2026 and the variance is real (§6), but the values are login strings with no
   human name behind them and no way to resolve one. Naming a person in a management report on the
   strength of an unresolvable login is a decision, not an engineering call.
3. **Should a machine account be shown, hidden, or bucketed as "unattributed"?** They dominate the
   failure population and are not people (§1.4).
4. **Does the >1 y source population (3,903, §9) belong to anyone?** It is six times #223's figure
   and currently has no owner.

**Answerable by further investigation, not yet done:**

5. Is `FIRST_INSTALLED_DATE_TIME` UTC? Inherited open question from #223 Q1. At a 48 h window a
   ±5.5 h error is immaterial, but it should be confirmed before any sub-12 h reporting.
6. What is the true median time-to-first-report? Not honestly answerable until `first_reported_at`
   has accumulated — which is another reason to ship that column early.
7. Does `INSTALLATION_REMARK` blank-ness correlate with a specific ingestion path? It is 27.4% NDD
   versus 3.1% for new installs and nobody has explained it.

---

## 11. What would make me say don't build this

Four things, in descending order of seriousness.

**1. The measurement partly undercuts the premise.** The brief opens with "devices fitted within the
last ~7 days are expected to be silent for a while." **They are not.** 97% report within 24 hours.
The commissioning window is real but it is small, and #223's existing 24 h threshold already covers
most of it. If the motivation for this view is *"stop alerting on devices that are legitimately
still commissioning"*, the honest answer is that the problem is roughly one-seventh the size it
looks, and #223 solves it as a side effect. The residual value is the install-quality measure — a
genuinely different and, in my view, better reason to build, but it should be the stated one.

**2. Most of the value is available today for the cost of a query.** Everything in §6 — the 97.5%
installer, the 69.2% plant, the 14.74 pp spread — came from single SQL statements against AutoPlant
production, with no FSM changes at all. A monthly report could be running this week. The page adds
routine, in-context visibility and joins the data to FSM's own state; it does not add the insight.
That is a real benefit, but it is perhaps 5% of the cost for 60% of the value, and it is worth
being honest that the expensive part buys convenience rather than knowledge. **The exception is
`first_reported_at`, which no query can recover later and which no amount of waiting will provide.**

**3. The installer dimension may not survive contact with reality.** ~20% of 2026 installs are `NA`,
machine accounts are over-represented among failures and need a hand-maintained pattern list, the
values resolve to no user master, and 7.28% of devices have had their recorded installer rewritten.
If §1 was the question that decides how much the idea is worth, the honest answer is: **worth
something, but less than a clean vendor-attribution field would be.** If the plan depends on
ranking named technicians, that plan is on softer ground than the plant-level view.

**4. It adds a fourth consumer to a state model that is being rewritten underneath it.** #222, #223,
#226, #227 and #228 are all in flight against `device_states` and the fleet identities. Adding a
cohort surface mid-rewrite risks the same class of problem #223 documents — a consumer built on a
predicate that changes meaning. Sequencing after #222+#223 land is not optional.

**None of these is fatal.** The recommendation is: **ship `first_reported_at` and the fitment fact
capture now, alongside #223, because that data is perishable; then decide on the page once a few
weeks of real cohort data exist and the true distribution can be read rather than inferred.** That
sequencing costs almost nothing, forecloses nothing, and replaces the one genuinely assumed number
in this document with a measured one.

---

## Appendix — provenance

All queries were read-only. Working scripts are in the session scratchpad, not committed.

| § | Source | Key objects |
|---|---|---|
| 1 | AutoPlant prod | `information_schema.COLUMNS`, `tb_vehiclemaster` |
| 2 | AutoPlant prod | `tb_vehiclemaster`, `ap_masters.mst_vehicle`, `mst_vehicle_log` (805,554 rows) |
| 3, 6 | FSM dev Postgres + repo | `raw_device_snapshots`, `device_states`, `devices`, `snapshot_runs`, `pg_class` |
| 4 | Repo | `dashboard.service.ts`, `dataset-registry.ts`, `dataset-query.ts`, `AppRoutes.tsx`, `nav.ts`, `.scratch/fsm-platform-v1/` |
| 5, 6 | AutoPlant prod | `tb_vehiclemaster` survival/variance aggregates |

Figures are as at 2026-08-09. `tb_vehiclemaster` = 62,994 rows; FSM `device_states` = 26,543 rows
(15,696 operational, 913 NDD) — consistent with #223's re-verified baseline.
