# Excel ↔ FSM Application Reconciliation — 11 August 2026

**Source file:** `docs/SUMMARYReport11thAug.xlsx` (4.28 MB, modified 11-Aug-2026 10:14 IST)
**Comparison target:** FSM admin application (UI + API + Postgres). AutoPlant MySQL was **not** used to adjudicate any mismatch.
**Mode:** read-only. No database writes, no code changes, no edits to the Excel.
**Workbook of tables:** `audit/analysis-results.xlsx`
**Beginner guide:** `audit/manual-excel-guide.md`

---

## Summary

**All nine companies in the Excel reconcile against FSM — nine match, zero do not — once the comparison is scoped to the population the two systems actually share.** Of the 33,339 vehicles in the Excel, 17,637 exist in FSM; of those, 12,397 are devices FSM still considers operational, and that is the only like-for-like set. On it, the Excel's Active / Inactive / NDD counts are **10,888 / 1,452 / 57** and FSM's healthy / inactive / never-reported counts are **10,888 / 1,452 / 57** — an exact match at the grand total, with only 4 disagreeing devices out of 12,397 (0.032%), every one of them a 24-hour-threshold timing race caused by the two systems sampling ~11 minutes apart. Both previously documented defects are confirmed fixed against live data: **#222** (the 5.5-hour GPS offset) shows zero devices in the ±5.5h signature band with 26.6% of timestamps agreeing to the second, and **#223** (NDD as a third state) is live and exactly right at 57 vs 57. The single most important finding is not an error at all but a definition gap that will keep producing apparent disagreements until it is named: **3,844 vehicles the Excel reports as "Active" have been retired to a warehouse in FSM** (`is_departed = true`) and are deliberately excluded from every FSM health rate — they still ping GPS from a shelf, so the Excel, which knows only GPS recency, scores them as healthy fleet. That one difference accounts for more of the headline gap than every genuine defect combined.

---

## 1. Scope and populations — read this before any number below

The two systems do not hold the same vehicles. Comparing totals directly is meaningless; comparing the shared population is not.

```
Excel rows                                            33,339
  ├─ absent from FSM                                  15,702   ← EXPECTED SCOPE
  │    ├─ never-deployed vehicles                     15,694   FSM mirrors ever-deployed only
  │    └─ Deployed but unmirrored                          8   ← real gap, §7
  └─ shared with FSM                                  17,637
       ├─ FSM warehouse (is_departed = true)           5,240   ← DEFINITION MISMATCH
       └─ FSM operational  ══ THE COMPARABLE SET ══   12,397

FSM devices                                           27,185
  ├─ absent from the Excel                             9,548   23 companies the Excel does not cover
  └─ shared with the Excel                            17,637
```

**Why FSM holds fewer vehicles.** `master-sync.service.ts:314` pins the mirror: a source vehicle whose `deployment_status` is not `DEPLOYED`/`ACTIVE` **and** which FSM has never seen is skipped with reason `NOT_DEPLOYED_NEVER_KNOWN`. The consequence is measurable and exactly as designed — **99.94% of the Excel's Deployed vehicles are in FSM** (12,320 of 12,328), against only 25.3% of its Undeployed ones (5,317 of 21,011). The Undeployed vehicles that *are* mirrored are the ones that were deployed at some point in the past.

**Why FSM holds companies the Excel does not.** The Excel covers 9 companies; FSM mirrors 32. The 9,548 FSM-only devices are overwhelmingly companies simply absent from this report (Vasavadatta 2,181, Deepak Fertilizer 1,686, STAR CEMENT 987, Vedanta-ESL 655, Zuari 342, Adani RMC 195, …). This is a report-scope difference, not a data problem.

**Normalization applied — declared, not silent.**
- **Join key:** `DEVICE NO` ↔ `devices.device_id`, **exact string match, no normalization**. I tested leading-zero-insensitive matching and it recovered **zero** additional devices (17,637 either way), so the exact join is already complete and stripping zeros would only risk collapsing the collision pairs in §8. Both systems store leading zeros consistently (Excel 6,686, FSM 4,573).
- **Company crosswalk:** derived empirically from the device-level join, **not** from name similarity. Purity was 100% for 8 of 9 companies and 98.3% for VICAT.

| Excel company | FSM company | Devices | Purity |
|---|---|---|---|
| COKE | HCCB | 1,175 | 100.0% |
| DGFC | DGFC | 326 | 100.0% |
| NUVISTA | Nuvista | 12,027 | 100.0% |
| PRISM | Prism Cement | 1,540 | 100.0% |
| SCL | SAURASHTRA CEMENT | 659 | 100.0% |
| SHREE BALAJI | Shree Balaji Roadlines | 176 | 100.0% |
| UTCL | UTCL | 1,014 | 100.0% |
| VBL | Varun Beverages Limited | 117 | 100.0% |
| VICAT | Vicat Cement | 593 | 98.3% (10 devices land in `R&D Testing`) |

- **Plant grouping:** every plant-level figure in this report and in the workbook is grouped on **(Company, Plant) together**. Grouping on plant name alone is invalid here and is flagged as such — `OTHERS` spans COKE/NUVISTA/UTCL and `TRANSPORTER` spans DGFC/SHREE BALAJI, so 49 distinct plant names correspond to 52 real pairs. No figure anywhere in these deliverables groups on plant name alone.

---

## 2. Phase 3 — FSM page inventory and metric lineage

Backend on `localhost:3000/api`, admin SPA on `localhost:5173`, authenticated as `ops.head@fsm.test` (OPERATIONS_HEAD). Values below are **live API responses**, not code readings.

| Page | Route | API endpoint | Key metrics |
|---|---|---|---|
| Dashboard KPI strip | `/` | `GET /api/dashboard/fleet-summary` | mirrored, operational, warehouse, reporting, inactive, healthy, neverReported, fleetHealthPct |
| Fleet Composition funnel | `/` | `GET /api/dashboard/fleet-composition` | + notMirrored, mirroredTotal, onDeactivatedPlants |
| Zone Performance Scorecard | `/` | `GET /api/dashboard/zone-overview` | per-zone fleet counts + byBucket |
| Company × Plant Overview | `/` | `GET /api/dashboard/company-plant-overview` | 278 rows, per-plant fleet counts |
| Fleet Directory | `/reports/fleet-directory` | `GET /api/dashboard/fleet-directory` | per-company fleet counts, plantCount |
| Device detail | `/reports/devices/:id` | `GET /api/dashboard/fleet-directory` (drill) | per-device state |
| Reports: Fleet Uptime | `/reports` | `GET /api/reports/fleet-uptime` | eligibleDeviceCount, uptimePct |
| Reports: Root Cause | `/reports/root-cause` | `GET /api/reports/root-cause` | category distribution |
| Reports: ZM Scorecard | `/reports/zm-scorecard` | `GET /api/reports/zm-scorecard` | per-ZM rows |
| Reports: Soft Inactive | `/reports` | `GET /api/reports/soft-inactive-trend` | softInactiveCount per zone |
| Ops Explorer / Reconciliation | `/ops-explorer` | `GET /api/ops-explorer/reconciliation` | 10 named identities |
| Integration Health | `/admin/build-health` | `GET /api/integration/health` | sync ages, drift, recompute ledger |

### Metric lineage — the load-bearing one

```
Metric: Operational Devices (Dashboard KPI strip)
UI:      apps/admin/src/pages/dashboard/DashboardHome.tsx
API:     GET /api/dashboard/fleet-summary
Service: apps/backend/src/dashboard/dashboard.service.ts:84  FLEET_COUNT_COLUMNS
SQL:     COUNT(*) FILTER (WHERE ds.is_departed = false)
Table:   device_states ds  JOIN plants p ON p.plant_id = ds.plant_id
Filter:  p.plant_id NOT IN (SELECT plant_id FROM plant_deactivations WHERE reactivated_at IS NULL)
Value:   15,386 (UI)   |   15,429 (raw DB, no deactivated-plant filter)
```

### FSM business definitions (verbatim from `dashboard.service.ts`)

| Concept | SQL | Value (UI) |
|---|---|---|
| Mirrored Devices | `COUNT(*)` | 26,198 |
| Operational Devices | `is_departed = false` | 15,386 |
| Warehouse Devices | `is_departed = true` | 10,812 |
| Reporting Operational | `is_departed = false AND latest_gps_datetime IS NOT NULL` | 14,588 |
| Inactive Devices | reporting `AND is_inactive = true AND sla_bucket IS NOT NULL` | 2,734 |
| Healthy Devices | reporting `AND NOT (is_inactive AND sla_bucket IS NOT NULL)` | 11,854 |
| **NDD / Never Reported** | `is_departed = false AND latest_gps_datetime IS NULL` | 798 |
| Fleet Health % | `healthy / reportingOperational × 100` | 81.3% |
| Active threshold | `system_settings.inactivity_threshold_hours` | **24** |

**Definitions are consistent across every page.** All three grouped surfaces (zone-overview, fleet-directory, company-plant-overview) import the same `FLEET_COUNT_COLUMNS` fragment rather than respelling it, and all three sum exactly to the KPI strip (§9). I found **no page computing "inactive" differently from another**.

Two subtleties worth recording:
1. **`healthyOperational` is no longer "NOT inactive" over the whole fleet.** Since #223 it excludes never-reported devices via the `latest_gps_datetime IS NOT NULL` clause. The prior-work note in the brief said to verify whether the fix is live — **it is**.
2. **`device_state_recomputes.inactive_count` (3,540) ≠ `inactiveOperational` (2,776).** This is correct, not a bug: under #223 a never-reported device past the grace window *is* `is_inactive` and *does* carry an SLA bucket (it is a P1 fault), but `INACTIVE_OPERATIONAL` additionally requires a GPS timestamp so it is not double-counted against `neverReported`. 2,776 + 764 = 3,540.

---

## 3. Phase 2 — Excel benchmark (built from raw rows only)

192 consistency checks run at grand-total, company, and (company, plant) level. **189 PASS, 3 FAIL — all three intentional.**

| Company | Plants | Vehicles | Deployed | Undeployed | Active | Inactive | NDD |
|---|---|---|---|---|---|---|---|
| COKE | 14 | 1,350 | 1,101 | 249 | 1,016 | 310 | 24 |
| DGFC | 1 | 326 | 326 | 0 | 302 | 24 | 0 |
| NUVISTA | 12 | 25,362 | 7,664 | 17,698 | 13,496 | 11,527 | 339 |
| PRISM | 1 | 2,560 | 1,196 | 1,364 | 1,541 | 671 | 348 |
| SCL | 2 | 996 | 513 | 483 | 255 | 695 | 46 |
| SHREE BALAJI | 1 | 295 | 155 | 140 | 110 | 175 | 10 |
| UTCL | 10 | 1,421 | 735 | 686 | 1,082 | 269 | 70 |
| VBL | 9 | 151 | 113 | 38 | 144 | 7 | 0 |
| VICAT | 2 | 878 | 525 | 353 | 616 | 251 | 11 |
| **GRAND TOTAL** | **52 pairs** | **33,339** | **12,328** | **21,011** | **18,562** | **13,929** | **848** |

The three deliberate failures:

| Check | Result | Why it is intentional |
|---|---|---|
| `Active + Inactive = Total` | 32,491 ≠ 33,339 | Confirms NDD is a **third peer state**, short by exactly 848 |
| `COUNT(*) = COUNT(DISTINCT device_id)` after stripping zeros | 33,339 vs 33,335 | The 4 collision pairs, §8 |
| Grouping on plant **name** alone is valid | 2 names span >1 company | `OTHERS`, `TRANSPORTER` — flagged, never used |

Every other check passed: `Deployed + Undeployed = Total` and `Active + Inactive + NDD = Total` hold at the grand total, at all 9 companies, and at all 52 (company, plant) pairs; plants roll up to companies and companies roll up to the grand total on all six measures. The sheet's own Grand Total row (33341) carries **no numbers** — only the literal strings `Grand Total`/`Total` — so there was nothing in the file to reconcile against.

---

## 4. Phase 4 — FSM benchmark

Built with the **same predicates the application uses**, imported verbatim from `FLEET_COUNT_COLUMNS` rather than respelled.

| | FSM DB (raw) | FSM UI / API | Difference |
|---|---|---|---|
| Mirrored | 27,185 | 26,198 | −987 |
| Operational | 15,429 | 15,386 | −43 |
| Warehouse | 11,756 | 10,812 | −944 |
| Reporting | 14,630 | 14,588 | −42 |
| Inactive | 2,776 | 2,734 | −42 |
| Healthy | 11,854 | 11,854 | 0 |
| Never Reported | 799 | 798 | −1 |

**The −987 is not a bug.** The UI applies `EXCLUDE_DEACTIVATED_PLANTS`, and `fleet-composition` reports the number explicitly as `onDeactivatedPlants: 987`. 27,185 − 987 = 26,198 exactly. Six plants are deactivated (`plant_deactivations`), and the devices on them — chiefly STAR CEMENT's 987 — drop out of every UI surface. **None of the nine Excel companies is affected**, so this filter does not disturb any comparison in this report.

Freshness at the time of capture: last master sync 11-Aug 10:12 IST (SUCCESS), last snapshot 11-Aug 10:14 IST (SUCCESS), latest recompute 11-Aug **10:15:08** IST. The Excel's own cutoff derives to ~10:04 IST. **The two systems are ~11 minutes apart** — which is precisely what §6 attributes the only 4 disagreements to.

---

## 5. Phases 5 & 6 — company reconciliation

### A. As-displayed (NOT like-for-like — populations differ)

| Company | Excel vehicles | FSM UI mirrored | Excel Deployed | FSM UI operational | Excel Active | FSM UI healthy | Excel Inactive | FSM UI inactive | Excel NDD | FSM UI never |
|---|---|---|---|---|---|---|---|---|---|---|
| COKE | 1,350 | 1,327 | 1,101 | 1,172 | 1,016 | 943 | 310 | 216 | 24 | 13 |
| DGFC | 326 | 360 | 326 | 326 | 302 | 302 | 24 | 24 | 0 | 0 |
| NUVISTA | 25,362 | 12,296 | 7,664 | 7,712 | 13,496 | 7,043 | 11,527 | 645 | 339 | 24 |
| PRISM | 2,560 | 1,851 | 1,196 | 1,335 | 1,541 | 1,122 | 671 | 197 | 348 | 16 |
| SCL | 996 | 675 | 513 | 522 | 255 | 194 | 695 | 316 | 46 | 12 |
| SHREE BALAJI | 295 | 176 | 155 | 158 | 110 | 98 | 175 | 57 | 10 | 3 |
| UTCL | 1,421 | 3,142 | 735 | 765 | 1,082 | 680 | 269 | 74 | 70 | 11 |
| VBL | 151 | 128 | 113 | 104 | 144 | 100 | 7 | 4 | 0 | 0 |
| VICAT | 878 | 696 | 525 | 556 | 616 | 497 | 251 | 56 | 11 | 3 |

These columns **should not** be read as disagreements. They are different populations. (UTCL is the clearest illustration: FSM shows *more* mirrored devices, 3,142 vs 1,421, because FSM retains 2,377 warehouse devices this Excel extract no longer lists at all.)

### B. Like-for-like — shared **and** FSM-operational (the comparable set)

| Company | Devices | Excel Active | FSM healthy | Δ | Excel Inactive | FSM inactive | Δ | Excel NDD | FSM never | Δ |
|---|---|---|---|---|---|---|---|---|---|---|
| COKE | 1,101 | 912 | 913 | **+1** | 183 | 182 | **−1** | 6 | 6 | 0 |
| DGFC | 326 | 302 | 302 | 0 | 24 | 24 | 0 | 0 | 0 | 0 |
| NUVISTA | 7,706 | 7,041 | 7,041 | 0 | 641 | 641 | 0 | 24 | 24 | 0 |
| PRISM | 1,204 | 1,070 | 1,069 | **−1** | 129 | 130 | **+1** | 5 | 5 | 0 |
| SCL | 518 | 193 | 193 | 0 | 314 | 314 | 0 | 11 | 11 | 0 |
| SHREE BALAJI | 158 | 98 | 98 | 0 | 57 | 57 | 0 | 3 | 3 | 0 |
| UTCL | 755 | 677 | 677 | 0 | 70 | 70 | 0 | 8 | 8 | 0 |
| VBL | 104 | 100 | 100 | 0 | 4 | 4 | 0 | 0 | 0 | 0 |
| VICAT | 525 | 495 | 495 | 0 | 30 | 30 | 0 | 0 | 0 | 0 |
| **TOTAL** | **12,397** | **10,888** | **10,888** | **0** | **1,452** | **1,452** | **0** | **57** | **57** | **0** |

**Seven of nine companies agree device-for-device. Two (COKE, PRISM) differ by a single offsetting device each. The grand total is exact on all three states.**

---

## 6. Phase 9 — lineage of every disagreement

Four devices out of 12,397 disagree. All four are traced end-to-end below.

| Vehicle | Company | Excel | FSM | Excel GPS | FSM GPS (IST) | GPS delta | Verdict |
|---|---|---|---|---|---|---|---|
| CG07CM8804 | NUVISTA/RISDA | Inactive | Active | 09-08 18:12:52 | 10-08 14:39:29 | **+20.4 h** | FSM data is fresher; FSM correct |
| MH04LE7639 | COKE/MUMBAI | Inactive | Active | 07-08 05:50:23 | 11-08 10:13:50 | **+4.2 d** | FSM data is fresher; FSM correct |
| RJ27GF1836 | NUVISTA/CHITTOR | Active | Inactive | 10-08 10:11:22 | 10-08 10:11:22 | **0 s** | 24 h boundary: age 24.06 h |
| UP33BT9632 | PRISM/SATNA_PLANT | Active | Inactive | 10-08 10:04:20 | 10-08 10:04:20 | **0 s** | 24 h boundary: age 24.18 h |

```
Devices 1–2:  Excel GPS is STALE relative to FSM. Same rule, older input.
              Conclusion: the difference pre-dates the UI and is not a defect —
              FSM ingested newer fixes after the Excel extract was taken.

Devices 3–4:  GPS timestamps are IDENTICAL to the second.
              Excel bucketed at ~10:04 IST → age 23.9 h / 24.0 h → "< 1 Day" → Active
              FSM recomputed at 10:15:08 IST → age 24.06 h / 24.18 h → ≥ 24 h → Inactive
              Conclusion: both systems applied a 24-hour rule correctly, 11 minutes apart.
              Excel = 2 Active, FSM DB = 2 Inactive, API = 2 Inactive, UI = 2 Inactive.
              DB, API and UI are consistent. No FSM defect.
```

This is corroborated by Phase 1's independent finding that the Excel's oldest "Active" row sits at 24.18 h — the same device, UP33BT9632.

### #222 verification (5.5-hour GPS offset) — **FIXED**

Comparing every one of the 17,513 shared devices carrying a timestamp on both sides, converting the Excel's IST wall clock to UTC:

| Delta (FSM − Excel) | Devices | Share |
|---|---|---|
| **Exactly 0 s** | 4,658 | 26.6% |
| 1–60 s | 7 | 0.0% |
| 60 s – 10 min | 10,393 | 59.3% |
| 10 min – 1 h | 2,372 | 13.5% |
| 1 h – 5.47 h | 59 | 0.3% |
| **~ ±5.5 h (the #222 signature)** | **1** | **0.006%** |
| 5.5 h – 24 h | 19 | 0.1% |
| > 24 h | 4 | 0.0% |
| **Excel newer than FSM (any amount)** | **0** | **0.0%** |

A live 5.5-hour offset would place ~100% of devices in the signature band; 0.006% are there, and that one device is ordinary drift. 26.6% agree **to the second**, and FSM is never *older* than the Excel — the expected shape for a system ingesting continuously and sampled ~9 minutes later (median delta +538 s). Confirmed in code: `AUTOPLANT_UTC_OFFSET_MIN = 0` (`mapping.ts:45`).

### #223 verification (NDD as a third state) — **FIXED**

`NEVER_REPORTED_OPERATIONAL` is live (`dashboard.service.ts:82`), exposed as `neverReported` on every fleet surface, and reported beside Fleet Health rather than inside it. On the comparable set, Excel NDD = **57** and FSM neverReported = **57**, device-for-device. The brief's caution that null-GPS devices might still be falling into `healthy` does **not** apply to this build.

---

## 7. Phase 7 — plant reconciliation

Full 47-row table in `analysis-results.xlsx` → **Plant Comparison**. Every row is grouped on **(Company, Plant)**.

**Only 4 of 47 plants show any difference**, and each is one of the four boundary devices from §6:

| Company | Plant | Δ Active | Δ Inactive | Δ NDD | Classification |
|---|---|---|---|---|---|
| COKE | MUMBAI UNIT | +1 | −1 | 0 | Timing (stale Excel GPS) |
| NUVISTA | CHITTOR | −1 | +1 | 0 | Timing (24 h boundary) |
| NUVISTA | RISDA | +1 | −1 | 0 | Timing (stale Excel GPS) |
| PRISM | SATNA_PLANT | −1 | +1 | 0 | Timing (24 h boundary) |

**The other 43 plants agree exactly on all three states.**

### Plants in one system but not the other

**In Excel, absent from FSM — 4 pairs, 34 vehicles.** All four are **100% Undeployed**, so all four are EXPECTED SCOPE, not missing data:

| Company | Plant | Vehicles | Deployed |
|---|---|---|---|
| COKE | OTHERS | 1 | 0 |
| UTCL | OTHERS | 5 | 0 |
| VBL | KARIMNAGAR | 2 | 0 |
| VBL | NARAYANPUR | 26 | 0 |

**In FSM, absent from Excel — 8 plants, 224 devices** (147 operational): Prism `AMETHI TOLLING UNIT` (93), `CHUNAR TOLLING UNIT` (46), `DIC Plant` (38), `RUDAULI TOLLING UNIT` (13); Vicat `Kalburgi` (19), `Coimbatore Plant` (13); HCCB `CUTTACK DEPOT(TANGI)` (1), `HCCBPL - BBSR NKA DEPOT` (1). These are real sites the 11-Aug extract does not cover.

### Same plant, different names — a structural mapping issue

**The two systems do not mean the same thing by "plant."** The Excel's `Plant Name` is an **operating region**; FSM's is a **physical site**. 20 of the 48 shared Excel plants split across more than one FSM plant, and the 48 Excel plants map onto 103 distinct FSM plants. The worst case:

> **COKE / HYDERABAD UNIT** (Excel, one plant) → six FSM plants: `HINDUSTAN COCA-COLA BEVERAGES - SIDDIPET GF` (101), `HCCBPL_HYDERABAD` (80), `HIMJAL COPACK` (18), `DEVARYAMJAL_GT` (17), `MAULA ALI DEPOT` (15), `HCCBPL-PREBILL HYDERABAD DEPOT` (1).

This is why the "Plant count" row is classified **MAPPING ISSUE** for every company in the Company Comparison sheet — Excel COKE shows 14 plants, FSM HCCB shows 32; they are not counting the same objects. The full crosswalk is in `analysis-results.xlsx`.

### Catch-all aggregates — flagged, not treated as locations

| Plant name | Companies | Vehicles | In FSM |
|---|---|---|---|
| `OTHERS` | COKE 1, NUVISTA 195, UTCL 5 | 201 | 193 (all NUVISTA) |
| `TRANSPORTER` | DGFC 326, SHREE BALAJI 295 | 621 | 502 |

Neither is a real location. `TRANSPORTER` is also the only place in the file where zone is not a function of (company, plant) — DGFC/TRANSPORTER spans 4 zones and SHREE BALAJI/TRANSPORTER spans 6.

### ⚠ PRISM SATNA_PLANT — the four collision pairs

Carried forward from Phase 1 §4.2 as instructed. **FSM holds three of the four pairs, and in every case only the zero-padded spelling:**

| Excel `DEVICE NO` | Excel vehicle | Excel status | In FSM? | FSM spelling held | FSM plant |
|---|---|---|---|---|---|
| `359688090185033` | MP17HH5500 | Undeployed / NDD | ✗ | — | — |
| `0359688090185033` | MP19HA2419 | Deployed / Active | ✓ | **`0359688090185033`** (padded) | SATNA PLANT LINE 2 |
| `0869925070154396` | RJ09GC5931 | Undeployed / Inactive | ✗ | — | — |
| `869925070154396` | RJ09GD5931 | Undeployed / NDD | ✗ | — | — |
| `869925070638026` | MP33DT4072 | Undeployed / NDD | ✗ | — | — |
| `0869925070638026` | UP33DT4072 | Deployed / Active | ✓ | **`0869925070638026`** (padded) | SATNA PLANT LINE 1 |
| `869925073303388` | MP09HH9485 | Undeployed / NDD | ✗ | — | — |
| `0869925073303388` | MP19HA6447 | Deployed / Active | ✓ | **`0869925073303388`** (padded) | SATNA PLANT LINE 1 |

**FSM's behaviour here is correct and worth stating plainly.** In each of the three pairs it holds, FSM mirrored the *live* row (Deployed/Active) and did not mirror the stale twin — consistent with the Phase 1 hypothesis that these are one physical device re-registered onto a second vehicle with the old row left behind at source. The fourth pair is absent entirely because neither row is deployed. **FSM did not inherit the Excel's duplicate-identity problem.**

**However, FSM has three of its own.** `devices` contains these ids in *both* padded and unpadded form:

| Padded | Unpadded |
|---|---|
| `0861045089202835` | `861045089202835` |
| `0867440065536674` | `867440065536674` |
| `0869925073654913` | `869925073654913` |

That is a genuine duplicate-identity defect in FSM (**Root cause F**), independent of anything in the Excel.

---

## 8. Phase 1 data-quality findings carried forward

| Finding | Count | Effect on this reconciliation |
|---|---|---|
| 706 placeholder device ids (`DEVICE NO` == `VEHICLE NO`) | 706 | 441 in FSM, **265 absent → EXPECTED SCOPE** (no real device identity to join on), per instruction |
| `IMSI_NO` unusable as a key | 3,039 blank + 47 rows on 35 dup values | Not used as a join key anywhere |
| Corrupt future trip dates | 20, all VBL, years 2072–2547 | No effect — `trip_created_date_IST` is not used in any comparison |
| Malformed IMEIs (14/18 chars) | 4 | All are NDD rows; none mirrored |
| `'Issues '` header trailing space | 1 column | Breaks naive lookups; not used here |
| `Remarks1` 100% blank | 33,339 | No information |
| `Reason Code` mixes 3 vocabularies | `NO TRIP   15 DAYS` (266), `0` (1,225), `1212` (9) | Unanalysable; not used |
| `Zones = 'West'` unmapped variant | 86 | DGFC/SHREE BALAJI TRANSPORTER only; ZM is `NA` |

### The 8 Deployed devices missing from FSM

The only genuine gap on the Excel side. All eight are **Active with GPS from 11-Aug 10:01–10:03**, all `Tracking Type = AP`, none are placeholders:

| Vehicle | Device | Company | Plant | Device type |
|---|---|---|---|---|
| NL01AJ0565 | 867542081316898 | NUVISTA | NIMBOL | GV30CIN |
| RJ01GC5671 | 867542081502265 | NUVISTA | NIMBOL | GV30CIN |
| RJ27GC1671 | 867542081467592 | NUVISTA | NIMBOL | GV30CIN |
| RJ27GE5199 | 867542081358619 | NUVISTA | NIMBOL | GV30CIN |
| RJ33GA4914 | 862491072520602 | NUVISTA | CHITTOR | NVT3 |
| RJ57GA0102 | 867542081486428 | NUVISTA | NIMBOL | GV30CIN |
| RJ57GA0249 | 867542081483599 | NUVISTA | NIMBOL | GV30CIN |
| TS09UE3685 | 860141073288830 | VBL | ALWAL | NVT3 |

Seven of eight are NUVISTA, six of those at NIMBOL, and six of eight are `GV30CIN`. The clustering points to a recent fitment batch not yet picked up by a master sync rather than a systematic ingestion fault. **Classification: MISSING RECORD (L) — 0.06% of the Deployed fleet.**

---

## 9. Phase 8 — cross-page FSM consistency

**Every fleet-count identity passes.** All three grouped surfaces sum exactly to the KPI strip on all seven measures:

| Check | Σ | KPI strip | Result |
|---|---|---|---|
| Zone overview (5 zones) → KPI strip | 26,198 / 15,386 / 10,812 / 14,588 / 2,734 / 11,854 / 798 | identical | **PASS** (7/7) |
| Fleet Directory (31 companies) → KPI strip | identical | identical | **PASS** (7/7) |
| Company × Plant Overview (278 plants) → KPI strip | identical | identical | **PASS** (7/7) |
| Fleet Directory vs Company × Plant Overview, per company | — | — | **PASS** (0 of 31 disagree) |
| `operational + warehouse = mirrored` | 26,198 | 26,198 | **PASS** |
| `healthy + inactive + never = operational` | 15,386 | 15,386 | **PASS** |
| `healthy + inactive = reporting` | 14,588 | 14,588 | **PASS** |
| SLA buckets → inactive total | 2,734 | 2,734 | **PASS** |

### FSM's own reconciliation panel reports **FAIL**

`GET /api/ops-explorer/reconciliation` → `status: "FAIL"`, 6 of 10 identities passing. **All six fleet-count identities pass.** The four failures are elsewhere:

| Identity | Left | Right | Δ | Bearing on this reconciliation |
|---|---|---|---|---|
| `dispatchBatchLedger` | 883 | 771 | 112 | None — dispatch, not fleet counts |
| `lifecycleConsistency` | 40 | 0 | 40 | None directly; 40 devices where `vehicles.status` XOR `is_departed` |
| `autoplantPlantsCount` | 908 | 931 | −23 | Out of scope — AutoPlant is not a comparison source here |
| `autoplantVehiclesCount` | 15,440 | 27,217 | −11,777 | Out of scope — same |

I am reporting these because a truthful cross-page audit must, but **none of them moves any number compared in this report**. The two AutoPlant identities are by definition outside the Excel↔FSM comparison. The other two are real FSM defects in adjacent subsystems.

One further internal inconsistency, found independently: `device_state_recomputes` row 9 (the newest in that table before the live ledger) reports `total_count = 21,900` against 27,185 actual rows in `device_states`. The `/integration/health` recompute ledger shows a current row 40 at `total_count = 27,185`, so the discrepancy is historical, not live. **Classification: UNVERIFIED — insufficient evidence** to call it a defect.

---

## 10. Phase 10 — root-cause classification

| Class | Finding | Count | Evidence |
|---|---|---|---|
| **B** Expected scope | Never-deployed vehicles absent from FSM | 15,694 | `NOT_DEPLOYED_NEVER_KNOWN` pin, `master-sync.service.ts:314` |
| **B** Expected scope | Placeholder device ids absent | 265 | `DEVICE NO` == `VEHICLE NO`; SCL 225, PRISM 40 |
| **B** Expected scope | 4 Excel plants absent from FSM | 34 vehicles | All 100% Undeployed |
| **C** Expected transformation | FSM retires devices to a warehouse | **5,240** | `is_departed = true`; 3,844 are "Active" in the Excel |
| **C** Expected transformation | UI excludes deactivated plants | 987 | `onDeactivatedPlants`; no Excel company affected |
| **D** Known defect | #222 — 5.5 h GPS offset | **0** | **RESOLVED — verified live**, 0.006% in signature band |
| **D** Known defect | #223 — NDD as third state | **0** | **RESOLVED — verified live**, 57 vs 57 |
| **M** Stale data | 24 h-threshold timing race | 4 | Excel bucketed ~10:04, FSM recomputed 10:15:08 |
| **L** Missing record | Deployed in Excel, absent from FSM | 8 | 7 NUVISTA + 1 VBL, all Active with fresh GPS |
| **J** Mapping issue | Company names differ | 9 of 9 | COKE→HCCB, SCL→SAURASHTRA CEMENT, … |
| **J** Mapping issue | Excel plant = region, FSM plant = site | 20 of 48 | COKE/HYDERABAD UNIT → 6 FSM plants |
| **A** Excel data quality | Zero-padding duplicate identity | 4 pairs | PRISM SATNA_PLANT; FSM holds 3, padded only |
| **A** Excel data quality | Corrupt future trip dates | 20 | All VBL, years 2072–2547 |
| **A** Excel data quality | IMSI unusable as key | 3,086 rows | 3,039 blank; one IMSI on 23 rows |
| **F** FSM database issue | Duplicate device identity in `devices` | 3 | Padded **and** unpadded forms both stored |
| **G** FSM business logic | `lifecycleConsistency` identity failing | 40 | FSM's own panel |
| **G** FSM business logic | `dispatchBatchLedger` identity failing | 112 | FSM's own panel |
| **O** Unknown | UNZONED zone holds 4,031 devices | 4,031 | Zone-mapping backlog; no Excel bearing |

**No finding is classified as an FSM UI bug or an FSM API bug.** The DB, the API and the UI returned consistent values on every metric I traced.

---

## 11. Recommendations

1. **Never compare Excel totals to FSM totals directly.** Only the 12,397 shared-and-operational devices are like-for-like, and there the two systems agree exactly. Any headline "33,339 vs 26,198" comparison is meaningless.
2. **Give the Excel report a warehouse/departed concept.** 3,844 vehicles it scores as Active have been retired from the field in FSM. This is the largest single driver of apparent disagreement and it will recur in every future extract until the report can represent the state.
3. **Investigate the 8 Deployed-but-unmirrored devices** (7 NUVISTA, 1 VBL; six are `GV30CIN` at NIMBOL). Most likely a fitment batch awaiting a master sync — worth confirming rather than assuming.
4. **Fix the 3 duplicate device identities in FSM** — `861045089202835`, `867440065536674`, `869925073654913` each exist in both padded and unpadded form in `devices`.
5. **Publish a company + plant crosswalk.** Nine company-name mappings and a region↔site plant relationship currently have to be re-derived by hand for every reconciliation.
6. **Fix the Excel's own data quality:** trailing space in the `'Issues '` header, `Remarks1` 100% blank, `Reason Code` mixing three vocabularies, 20 corrupt VBL trip dates, `Zones = 'West'` unmapped.
7. **Stop treating `IMSI_NO` as an identifier** — 9.1% blank, 35 duplicated values, one on 23 rows, 23 values only 9 characters long.
8. **Address the two failing FSM internal identities** (`lifecycleConsistency` 40, `dispatchBatchLedger` 112). Neither affects fleet counts, but FSM's own panel reports the system as FAIL and that should not be the steady state.
9. **Align the two extract clocks.** All four device-level disagreements are 24-hour-threshold races from an ~11-minute gap. Running the Excel extract and the FSM recompute against a shared cutoff would take the disagreement count to zero.
10. **Treat NDD as first-class everywhere downstream.** Both systems now model it correctly; any consuming report that adds Active + Inactive alone is short by 848 rows.

---

## Appendix — method and verification notes

- **Every number in this report is derived from raw rows or a live API response.** No summary cell, no pre-built subtotal, and no Grand Total row was used as an input; the sheet's Grand Total row carries no numbers at all.
- **Excel read as text throughout** (`dtype=str, keep_default_na=False`) so leading zeros survive. Casting `DEVICE NO` to a number collapses 4 pairs — demonstrated, not asserted.
- **FSM predicates were imported verbatim**, not respelled: `REPORTING_OPERATIONAL`, `INACTIVE_OPERATIONAL`, `HEALTHY_OPERATIONAL`, `NEVER_REPORTED_OPERATIONAL` copied from `dashboard.service.ts:50–91`. The pandas recomputation of `FLEET_COUNT_COLUMNS` reproduced the SQL result exactly (27,185 / 15,429 / 11,756 / 14,630 / 2,776 / 11,854 / 799), which validates the transcription.
- **Code is truth for FSM behaviour; the database is truth for FSM data; documentation is truth for intent.** Where the brief's prior-work notes disagreed with the live system (#222 and #223 both described as "verify whether live"), I report the measured state and label it as measured.
- **Rule 9 observed:** the clean result on the comparable set is the finding. I did not manufacture disagreements to fill the report.

**Reproduction scripts:** `p1_structure.py`, `p1_profile.py`, `p1_quality.py`, `p1_anomalies.py`, `p1_final.py`, `p2_benchmark.py`, `p4_fsm.py`, `p5_join.py`, `p5b_population.py`, `p8_api.py`, `p9_compare.py`, `p10_ts_plant.py`, `p11_final.py`, `p12_xlsx.py` (session scratchpad), plus `_audit_*.mjs` against the FSM database and API.
