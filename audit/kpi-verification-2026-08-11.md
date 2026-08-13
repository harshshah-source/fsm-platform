# Dashboard KPI Verification against the Excel — 11 August 2026

**Source:** `docs/SUMMARYReport11thAug.xlsx` (33,339 data rows)
**Target:** FSM admin dashboard — live API on `localhost:3000/api`, authenticated as `ops.head@fsm.test`
**Companion:** `audit/analysis-report.md` (the lineage half — DB/API/UI agree with *each other*)
**Mode:** read-only. SELECTs and GETs only.

---

## Part 0 — How does FSM know a device is "sitting in a warehouse"?

**It doesn't. That is a label, not an observation.** FSM never sees a warehouse. What it actually knows is narrower, and the distinction matters for every number below.

`is_departed` is a denormalised mirror of "this device has an open row in `device_departures`". Those rows are written by `DeviceDepartureService.reconcileDepartures` during master sync, from **two detection paths that the code itself declares unequal in trust** (`device-departure.service.ts:19–29`):

| Path | What FSM actually observed | Trust | Fleet-wide |
|---|---|---|---|
| `SOURCE_STATUS` | AutoPlant's widened read returned this device with a **non-operational `deployment_status`** — verbatim `UNDEPLOYED` (8,955) or `MAINTENANCE` (112) | Observed. Applied unconditionally. | **9,067 (77.1%)** |
| `ABSENT_FROM_READ` | The device was **in no source row at all**. AutoPlant drops a `device_id` outright when a vehicle is unfitted. | **Inferred.** Guard-railed: only meaningful inside the plant scope the read covered, and a swing past 10% aborts the whole absence pass. | **2,689 (22.9%)** |

So the honest statement is: **FSM knows these devices are not in the deployed fleet.** For 77% it knows that because the source said so; for 23% it knows only that the source stopped mentioning them.

### Does the evidence hold up against the Excel?

This is the useful test, because the Excel carries its own independent `Deployment Status` column. On the 5,240 shared devices FSM has departed:

| FSM `observed_status` | Excel says Deployed | Excel says Undeployed | Total |
|---|---|---|---|
| `UNDEPLOYED` | 13 | **5,218** | 5,231 |
| `MAINTENANCE` | 2 | 5 | 7 |
| `MISSING_FROM_SOURCE` | 1 | 1 | 2 |
| **Total** | **16** | **5,224** | **5,240** |

**5,218 of 5,240 (99.6%) — FSM observed `UNDEPLOYED` and the Excel independently agrees the vehicle is Undeployed.** Two systems, two extracts, same conclusion. And note that within this shared population only **2 of 5,240** rest on the inferred absence path — the inference problem is real fleet-wide but almost absent here.

**The two systems do not disagree about deployment. They disagree about what to do with a not-deployed vehicle.** FSM stops scoring it. The Excel keeps scoring it on GPS recency — and since a device on a shelf still has power and still pings, 3,844 of them come back "Active".

### The caveat you should carry

Two facts sit uncomfortably with the word "warehouse":

- **34.0% of departed devices (3,993 of 11,756) sent a GPS fix in the last 24 hours.** Some are genuinely shelved units still powered; some are plausibly still fitted to a vehicle that was merely re-statused at source. FSM cannot tell these apart, and neither can I from this data. **UNVERIFIED — insufficient evidence** to say what fraction is which.
- **16 devices FSM has departed are `Deployed` in the Excel**, 14 of them `Active`, clustered in VBL/KARMANGHAT and VBL/KATEDHANA. These are the cases where the two systems genuinely contradict each other on deployment, not just on scoring.

The mechanism is at least self-consistent and reversible: `is_departed` and the departure ledger agree on **all 27,185 rows with zero contradictions**, and 2,018 departures have already been auto-restored when the device was seen operational again.

---

## Part 1 — Method

The KPI strip covers **31 companies**; the Excel covers **9**. Comparing them directly is meaningless. Every table below therefore reports three columns:

- **UI (as displayed)** — the live API value, full scope.
- **FSM on comparable** — FSM's own predicates recomputed over only the devices the Excel also has.
- **Excel on comparable** — what the Excel says about those same devices.

**Comparable population = 17,637 devices** (present in both systems, none on a deactivated plant — I verified that **zero** Excel devices sit on one). Of those, **12,397 are FSM-operational**.

**Transcription validated first.** Before comparing anything I re-derived all seven KPI tiles from raw `device_states` using the predicates copied verbatim from `FLEET_COUNT_COLUMNS`:

| Tile | My recomputation | Live UI | |
|---|---|---|---|
| mirrored | 26,198 | 26,198 | ✓ |
| operational | 15,386 | 15,386 | ✓ |
| warehouse | 10,812 | 10,812 | ✓ |
| reporting | 14,588 | 14,588 | ✓ |
| inactive | 2,734 | 2,734 | ✓ |
| healthy | 11,854 | 11,854 | ✓ |
| neverReported | 798 | 798 | ✓ |

Seven of seven. Everything below rests on a validated transcription, not an assumption.

---

## Part 2 — Surface by surface

### 2.1 Dashboard KPI strip · Fleet Composition funnel

`GET /api/dashboard/fleet-summary` · `GET /api/dashboard/fleet-composition`

| Tile | UI (31 companies) | FSM on comparable | Excel on comparable | Diff | Verdict |
|---|---|---|---|---|---|
| Mirrored Devices | 26,198 | 17,637 | 17,637 | 0 | **MATCH** |
| Operational Devices | 15,386 | 12,397 | 12,397 | 0 | **MATCH** |
| Warehouse Devices | 10,812 | 5,240 | 5,240 | 0 | **MATCH** |
| Reporting Operational | 14,588 | 12,340 | 12,340 | 0 | **MATCH** |
| Inactive Devices | 2,734 | 1,452 | 1,452 | 0 | **MATCH** |
| Healthy Devices | 11,854 | 10,888 | 10,888 | 0 | **MATCH** |
| Never Reported (NDD) | 798 | 57 | 57 | 0 | **MATCH** |

**Seven of seven agree exactly.** The Excel supports every KPI tile on the population the two systems share.

Funnel-only fields: `mirroredTotal` 27,185 · `onDeactivatedPlants` 987 (all STAR CEMENT, across 5 plants: BARPETA ROAD 341, COSSIMBAZAR 280, CHANGSARI 207, DIBRUGARH 135, SCNEL SILCHAR 24) · `notMirrored` 23,989 · `catalogDevices` 51,174. None has an Excel counterpart — `catalogDevices` is explicitly documented as a source metric, not an operational one. **UNVERIFIED (no Excel equivalent)**, which is correct rather than a problem.

### 2.2 Zone Performance Scorecard

`GET /api/dashboard/zone-overview`

Zone attribution was derived from the device join, not from name similarity. **It is not clean in either direction** — Excel `East A` lands mostly in FSM `East` (2,097) but also `West` (5) and `UNZONED` (2); Excel `NA` splits across `South` (648), `West` (208), `UNZONED` (63), `East` (5). I therefore compare on **FSM's zone attribution**, which is what the UI actually renders.

| Zone | UI operational | Comparable devices | FSM healthy | Excel Active | FSM inactive | Excel Inactive | FSM never | Excel NDD | Δ |
|---|---|---|---|---|---|---|---|---|---|
| East | 6,049 | 8,701 | 5,466 | 5,466 | 550 | 550 | 13 | 13 | **0** |
| North | 3,269 | 4,886 | 2,662 | 2,663 | 244 | 243 | 11 | 11 | ±1 |
| South | 1,706 | 1,917 | 1,415 | 1,415 | 144 | 144 | 10 | 10 | **0** |
| West | 1,811 | 1,735 | 1,002 | 1,001 | 468 | 469 | 22 | 22 | ±1 |
| UNZONED | 2,551 | 398 | 343 | 343 | 46 | 46 | 1 | 1 | **0** |
| **TOTAL** | — | **17,637** | **10,888** | **10,888** | **1,452** | **1,452** | **57** | **57** | **0** |

Three zones exact; North and West carry one offsetting boundary device each (the same four from the main report). **Grand total exact on all three states.**

### 2.3 Fleet Directory (company grain)

`GET /api/dashboard/fleet-directory`

| Company | Comparable operational | FSM healthy | Excel Active | FSM inactive | Excel Inactive | FSM never | Excel NDD | Verdict |
|---|---|---|---|---|---|---|---|---|
| COKE | 1,101 | 913 | 912 | 182 | 183 | 6 | 6 | ±1 boundary |
| DGFC | 326 | 302 | 302 | 24 | 24 | 0 | 0 | **MATCH** |
| NUVISTA | 7,706 | 7,041 | 7,041 | 641 | 641 | 24 | 24 | **MATCH** |
| PRISM | 1,204 | 1,069 | 1,070 | 130 | 129 | 5 | 5 | ±1 boundary |
| SCL | 518 | 193 | 193 | 314 | 314 | 11 | 11 | **MATCH** |
| SHREE BALAJI | 158 | 98 | 98 | 57 | 57 | 3 | 3 | **MATCH** |
| UTCL | 755 | 677 | 677 | 70 | 70 | 8 | 8 | **MATCH** |
| VBL | 104 | 100 | 100 | 4 | 4 | 0 | 0 | **MATCH** |
| VICAT | 525 | 495 | 495 | 30 | 30 | 0 | 0 | **MATCH** |

**Seven of nine exact; two carry a single offsetting device.**

How much of each company the Excel actually covers (the gap between the tile and the comparable set is scope, not error):

| Company | UI operational | Comparable | UI healthy | Comparable healthy | UI inactive | Comparable inactive |
|---|---|---|---|---|---|---|
| COKE | 1,172 | 1,101 | 943 | 913 | 216 | 182 |
| DGFC | 326 | 326 | 302 | 302 | 24 | 24 |
| NUVISTA | 7,712 | 7,706 | 7,043 | 7,041 | 645 | 641 |
| PRISM | 1,335 | 1,204 | 1,122 | 1,069 | 197 | 130 |
| SCL | 522 | 518 | 194 | 193 | 316 | 314 |
| SHREE BALAJI | 158 | 158 | 98 | 98 | 57 | 57 |
| UTCL | 765 | 755 | 680 | 677 | 74 | 70 |
| VBL | 104 | 104 | 100 | 100 | 4 | 4 |
| VICAT | 556 | 525 | 497 | 495 | 56 | 30 |

VICAT is the widest gap — the UI shows 56 inactive against 30 on the comparable set, because 26 Vicat devices sit at `Kalburgi`, `Coimbatore Plant` and `Vicat Inbound`, sites this Excel extract does not cover.

### 2.4 Company × Plant Overview

`GET /api/dashboard/company-plant-overview` — 278 rows. Grouped on **(Company, Plant)** throughout; grouping on plant name alone is invalid in FSM too (see §3.2).

98 FSM plants appear in the comparable set. **94 agree exactly. 4 differ, each by one device** — and each of the four is one of the four known 24-hour boundary races:

| FSM company | FSM plant | Devices | FSM healthy | Excel Active | FSM inactive | Excel Inactive |
|---|---|---|---|---|---|---|
| HCCB | HCCBPL_WADA | 198 | 173 | 172 | 24 | 25 |
| Nuvista | CCP-9115 | 1,260 | 1,198 | 1,199 | 62 | 61 |
| Nuvista | RCP-5151 | 460 | 400 | 399 | 60 | 61 |
| Prism Cement | SATNA PLANT LINE 1 | 614 | 559 | 560 | 51 | 50 |

**No plant differs by more than one device, and no plant differs on NDD at all.**

### 2.5 SLA bucket distribution

FSM's bands (`packages/shared`, `SLA_BANDS`) and the Excel's `Bucket By Days` do not use the same cut points, so I derived the mapping from the measured hour ranges in Phase 1 rather than from the labels:

| Excel bucket | Measured age range | Maps to FSM |
|---|---|---|
| `(01-02) Days` | 24.2 – 48.0 h | `CRITICAL` (24–48h) |
| `(03-07) Days` | 48.3 – 167.7 h | `HIGH_CRITICAL` + `SEVERE` + `VERY_SEVERE` (48–168h) |
| `(08-15)` + `(16-30)` + `> 30 Days` | ≥ 168 h | `LONG_PENDING` (168h+) |

Cross-tab on the 1,452 comparable inactive devices:

| Excel group ↓ / FSM group → | CRITICAL | HC+SEV+VSEV | LONG_PENDING | Total |
|---|---|---|---|---|
| CRITICAL | **255** | 0 | 0 | 255 |
| HC+SEV+VSEV | 0 | **733** | 0 | 733 |
| LONG_PENDING | 0 | 0 | **462** | 462 |
| **Total** | 255 | 733 | 462 | **1,450** |

**Perfectly diagonal — 1,450 of 1,452 (99.9%).** Zero off-diagonal cells. The 2 unaccounted are the boundary devices the Excel still calls `< 1 Day` (Active), so they have no inactive bucket on the Excel side.

Raw bucket counts:

| SLA bucket | UI (all companies) | FSM on comparable |
|---|---|---|
| CRITICAL | 300 | 257 |
| HIGH_CRITICAL | 261 | 231 |
| SEVERE | 677 | 390 |
| VERY_SEVERE | 161 | 112 |
| LONG_PENDING | 1,335 | 462 |
| **TOTAL** | **2,734** | **1,452** |

UI bucket total = `inactiveOperational` (2,734 = 2,734) ✓. **Verdict: MATCH.**

---

## Part 3 — The three specific questions

### Q1. Does Fleet Health % use the right denominator?

**Numerator and denominator verified separately, as asked.** On the comparable set:

| Half | Excel | FSM | |
|---|---|---|---|
| **Numerator** — healthy / Active | 10,888 | 10,888 | **AGREE** |
| **Denominator** — reporting / Active+Inactive | 12,340 | 12,340 | **AGREE** |
| Excluded from denominator — NDD / neverReported | 57 | 57 | **AGREE** |

**Both halves are independently correct.** This is not a percentage that came out right by accident: numerator, denominator, and the excluded set each agree on their own.

**But your suspicion about the exclusion is correct, and it is bigger than it looks.**

| Denominator | Fleet Health | n | Share of mirrored fleet |
|---|---|---|---|
| `reportingOperational` (**as built**) | **81.26%** | 14,588 | 55.7% |
| `operationalDevices` (never-reported back in, scored 0%) | 77.04% | 15,386 | 58.7% |
| `mirroredDevices` (warehouse back in too) | 45.25% | 26,198 | 100% |

Excluding never-reported devices flatters Fleet Health by **+4.21 percentage points fleet-wide**.

On the comparable set the same exclusion is worth only **+0.41 pp** — and that gap between +0.41 and +4.21 is itself the finding. The never-reported devices are **concentrated outside the Excel's scope**: of 798, only **57** are in the nine Excel companies. The rest cluster in Vasavadatta (545) and Deepak Fertilizer (115). **The Excel cannot see the flattering effect, because it does not cover the companies where it happens.** Anyone validating Fleet Health against this Excel would conclude the denominator is fine. It is defensible, but it is not fine.

The exclusion was a deliberate operator decision (P3, 2026-08-09, documented at `dashboard.service.ts:137–142`) with `neverReported` reported beside the KPI rather than inside it, so nothing is hidden. My finding is about **magnitude, not concealment**: the headline number describes **55.7% of the mirrored fleet**, and the label does not say so.

### Q2. What would each KPI read if the 3,844 warehouse-Active devices were included?

I re-scored **every** device by FSM's own 24-hour rule while ignoring `is_departed`. **Method validated first:** on non-departed devices the re-score reproduces FSM exactly — healthy 11,854, inactive 2,734, never 798, all three identical to the live API. So the deltas below come from the population change alone, not from a different rule.

**Fleet-wide (all 31 companies):**

| Tile | As displayed | If warehouse included | Delta | % change |
|---|---|---|---|---|
| Mirrored Devices | 26,198 | 26,198 | 0 | — |
| Operational Devices | 15,386 | 26,198 | **+10,812** | +70.3% |
| Warehouse Devices | 10,812 | 0 | −10,812 | −100% |
| Reporting Operational | 14,588 | 24,205 | +9,617 | +65.9% |
| **Healthy Devices** | 11,854 | 15,842 | **+3,988** | +33.6% |
| **Inactive Devices** | 2,734 | 8,363 | **+5,629** | **+205.9%** |
| **Never Reported** | 798 | 1,993 | **+1,195** | +149.7% |
| **Fleet Health %** | **81.3%** | **65.4%** | **−15.8 pp** | |
| **Inactive %** | 18.7% | 34.6% | +15.8 pp | |

**Fleet Health would fall from 81.3% to 65.4%.** Inactive would triple. The warehouse exclusion is carrying more of the dashboard's optimism than the never-reported exclusion by a factor of nearly four (15.8 pp vs 4.21 pp).

**Restricted to the nine Excel companies — and this is the sharpest result in the whole exercise:**

| Tile | FSM now (excl. warehouse) | FSM if included | **Excel (all shared)** | Excel − FSM |
|---|---|---|---|---|
| Operational | 12,397 | 17,637 | 17,637 | **0** |
| Warehouse | 5,240 | 0 | 0 | **0** |
| Reporting | 12,340 | 17,514 | 17,513 | **−1** |
| Inactive | 1,452 | 2,780 | 2,781 | **+1** |
| Healthy | 10,888 | 14,734 | 14,732 | **−2** |
| Never Reported | 57 | 123 | 124 | **+1** |

**Fold the warehouse devices back in and FSM matches the Excel across the entire 17,637-device shared population to within 2 devices.** Not just the operational slice — everything.

That is the cleanest possible proof of what the 3,844 actually are: **not a data disagreement at all.** Both systems classify those devices identically when the same rule is applied to them. The gap is one filter — `is_departed = false` — and nothing else.

### Q3. Is any KPI computed from a different population than its label implies?

Five flagged, in descending order of how much they could mislead.

| # | Tile / label | What the SQL actually counts | Severity |
|---|---|---|---|
| 1 | **"Fleet Health %"** | Health of `reportingOperational` = **55.7% of the mirrored fleet**. Excludes 10,812 warehouse **and** 798 never-reported — 44.3% of devices, none of it stated on the tile. | **High** |
| 2 | **"Warehouse Devices"** — interface doc says *"Removed from field operations (an open `device_departures` row) — in a warehouse, not broken"* | `is_departed = true`, driven by AutoPlant `deployment_status`. **22.9% (2,689) are inferred from absence**, never observed as anything. **34.0% (3,993) sent GPS in the last 24h.** FSM has no warehouse evidence. | **High** |
| 3 | **"Mirrored Devices" = 26,198** — doc says *"Every device FSM mirrors"* | Every device FSM mirrors **minus 987 on deactivated plants**. `device_states` holds 27,185. | **Medium** — the funnel does expose both (`mirroredTotal` 27,185, `onDeactivatedPlants` 987), so it is discoverable one click away. |
| 4 | **Zone Performance Scorecard** | Includes **UNZONED**, which is not a zone: 2,551 operational devices (16.6% of the fleet), **602 of the 798 never-reported (75.4%)**, Fleet Health 42.1%, and a zonal manager literally named *"ZM Zone 5 (mock)"*. A mock ZM is rendered beside four real ones on a performance scorecard. | **Medium** |
| 5 | **"plants" = 278** | Plants **with at least one mirrored device**, not plants on file (`plants` has 931 rows). The count is of `plant_id` — correct — but note FSM has the same trap as the Excel: 278 plant IDs share only 274 distinct names (`DEPOT_GGU` ×3, `GIFT CITY` ×2, `RCM` ×2). Any future grouping on plant *name* would be wrong in FSM too. | **Low** |

**No tile is computed from a population that contradicts its SQL** — every one is internally consistent and every one reconciles across pages. The issue in all five cases is that the **label understates the filtering**, not that the arithmetic is wrong.

Two things I checked and found clean: `Inactive Devices` and `Never Reported` are counted over exactly the population their names imply, and the `inactivePct`/`fleetHealthPct` pair share one denominator so they sum to 100% by construction (18.7 + 81.3).

---

## Part 4 — Verdict

| Surface | Tiles checked | Agree with Excel |
|---|---|---|
| Dashboard KPI strip | 7 | **7 / 7** |
| Fleet Composition funnel | 4 extra fields | n/a (no Excel counterpart) |
| Zone Performance Scorecard | 5 zones × 3 states | **13 / 15** (2 × ±1 boundary) |
| Fleet Directory | 9 companies × 3 states | **25 / 27** (2 × ±1 boundary) |
| Company × Plant Overview | 98 plants | **94 / 98** (4 × ±1 boundary) |
| SLA bucket distribution | 1,452 devices | **1,450 / 1,452 (99.9%)** |

**Every KPI on the dashboard is supported by the Excel data on the population the two systems share.** Every exception traces to the same four devices sitting within minutes of the 24-hour threshold at two different sampling instants.

### What I would actually change

1. **Put the denominator on the Fleet Health tile.** "81.3% of 14,588 reporting devices" is honest; "81.3%" invites the reader to think it describes 26,198. The number is right; the framing is generous.
2. **Rename "Warehouse Devices."** FSM does not observe warehouses. "Not in the deployed fleet" is what it knows. Consider splitting the tile by reason — 9,067 observed vs 2,689 inferred are different claims and should not be one number.
3. **Show the warehouse-included Fleet Health somewhere.** 65.4% vs 81.3% is a 15.8-point difference in how the fleet looks, driven entirely by a filter. Both are defensible; only one is currently visible.
4. **Get UNZONED off the zone scorecard, or label it.** 16.6% of the operational fleet and 75.4% of all never-reported devices are being attributed to a bucket with a mock manager.
5. **Investigate the 16 Deployed-but-departed devices** — mostly VBL/KARMANGHAT and VBL/KATEDHANA. These are the only cases where FSM and the Excel genuinely contradict each other on deployment rather than on scoring.

### Method notes

- All FSM predicates copied verbatim from `dashboard.service.ts:50–91`; the transcription reproduces all seven live KPI values exactly before any comparison was made.
- The Q2 re-score reproduces FSM's own healthy/inactive/never counts exactly on non-departed devices, so the reported deltas isolate the population change.
- Excel↔FSM device join is exact-string on `DEVICE NO` ↔ `devices.device_id`; leading-zero normalization was tested and recovered zero extra matches, so none was applied.
- Every plant figure groups on **(Company, Plant)**. No figure anywhere groups on plant name alone.
- Zone and company crosswalks derived from the device-level join, not from name similarity.
- Where I could not establish a fact — what fraction of departed-but-still-pinging devices are genuinely shelved — it is marked **UNVERIFIED — insufficient evidence** rather than estimated.
