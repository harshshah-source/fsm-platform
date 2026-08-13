# AutoPlant ⇄ FSM Reconciliation 

**Source Excel:** `docs/autoplant/SUMMARYREPORTDeployedNEW.xlsx`, sheet `Sheet 1` — **33,338 data rows**
(rows 2–33339). Row 33340 `Grand Total` excluded.
**FSM:** dev instance `localhost:5433/fsm` — device data is a real AutoPlant mirror; org/ticket data is seeded.
**Source of truth for adjudication:** AutoPlant production MySQL (`ap_masters`, `ap_widgets`), read-only.

**Snapshot anchors**

| System | As of (IST) | Derived from |
|---|---|---|
| Excel | `2026-08-10 14:48:10` | `max(GPS_DATE_TIME)`, corroborated by the 60-min ONLINE boundary (~14:51) |
| FSM | `2026-08-10 14:34:55` | `max(device_states.latest_gps_datetime)`; `computed_at = 14:35:50` |
| Gap | **13m 15s** | Material only at the 24h Active/Inactive boundary — 2 vehicles affected |

> **This supersedes nothing.** `reconciliation-report.md` (2026-08-07) covers a *different, older* export
> (`SUMMARY_REPORT.xlsx`, 25,214 rows, 12 plants). This file covers `SUMMARYREPORTDeployedNEW.xlsx`
> (33,338 rows, 9 companies, 52 company-plant pairs). Findings differ; see §7.

---

## 1. Verdict

**FSM's fleet figures are correct.** Within the population both systems cover, FSM classifies devices as
Active / Inactive / Never-reported with **99.91% agreement** (12,450 / 12,461). All 11 disagreements
resolve either in FSM's favour or to the 13-minute snapshot gap — none is a classification defect.

**One expectation inverted.** The brief was to assume FSM wrong until proven otherwise. On *deployment
status* that is backwards: against `ap_masters.mst_vehicle.deployment_status`, **FSM matches 99.88% and
the Excel 99.04%**. Of 161 disputed vehicles the source backs **FSM in 158, the Excel in 2**.

| Metric | Result |
|---|---|
| Excel internal consistency checks | **19 / 19 pass** |
| State agreement, shared operational fleet | **99.91%** (12,450 / 12,461) |
| FSM `is_departed` vs AutoPlant | **99.90%** (17,576 / 17,593) |
| FSM `vehicles.status` vs AutoPlant | **99.88%** (17,572 / 17,593) |
| Excel `Deployment Status` vs AutoPlant | **99.04%** (17,424 / 17,593) |
| Genuine FSM defects found | **4** (all small; none moves a headline figure) |

---

## 2. Phase 1 — Excel structure and derived business rules

Single sheet, 33,340 rows × 24 cols. The zip contains **no `calcChain.xml` and zero formula cells** — a
flat export. Every cell, including dates and numbers, is stored as a **string**. No formulas means no
encoded business rules; all rules below are inferred from data and verified across all 33,338 rows.

**Grain: one row per vehicle.** `VEHICLE NO` = 33,338 distinct / 33,338 rows; `DEVICE NO` = 33,338
distinct / 33,338 rows — both unique, verified not assumed. `IMSI_NO` is **not** a key (3,024 blank,
35 duplicate rows, one value on 23 rows, same identity written with and without a leading zero).

### 2.1 Column semantics (all verified against row counts)

| Column | Meaning | Verified by |
|---|---|---|
| `Deployment Status` | Binary peer states. **Not** trip-derived in this export — see §2.2. | Deployed 12,366 + Undeployed 20,972 = 33,338 |
| `Active_Inactive` | **Active** = GPS age < 24h · **Inactive** = ≥ 24h · **NDD** = no GPS ever. NDD is a **third peer state**, not a flavour of Inactive. | 18,486 + 13,997 + 855 = 33,338; cross-tab vs `Bucket By Days` is perfectly diagonal |
| `Bucket By Days` | GPS-age partition, contiguous, no gaps/overlaps: `[0,1) [1,2) [2,7) [7,15) [15,30) [30,∞)` days. Labels are **off-by-one** — `(03-07) Days` actually holds ages 2.00–6.99. | min/max age per bucket; boundary at 29.93 → 30.01 |
| `Device Status` | Precedence: **NDD** (no GPS) → **EPF** (`VEHICLE POWER STATUS = 1`) → **ONLINE** (age ≤ ~60 min) → **NOT REACHABLE**. | EPF ≡ power=1, **3,998 exact, zero exceptions**; ONLINE max age 62.73 min vs NOT REACHABLE min 62.90 min — zero overlap |
| `Zones` → `Zonal Manager` | Clean functional dependency, 8 zones → 5 managers. | 1:1 verified; no zone maps to two managers |
| `Shift` | `'NA'` ≡ no trip. | `Shift='NA'` ≡ `trip_created_date_IST` blank — 18,722, **identical row sets** |

### 2.2 Rules that differ from the 2026-08-07 export

- **`Deployment Status` is NOT trip-derived here.** The prior file's rule (*"all Deployed have a trip
  date"*) fails: **326 Deployed rows have no trip** and **2,576 Undeployed rows do**. Trip-presence
  explains only **91.3%** of the column; `mst_vehicle.deployment_status` explains **99.04%**. The column
  mirrors the master, not trip state.
- **`Issues` is not confined to Deployed rows.** 21,298 blank overall; the column also carries the value
  `NDD` (68 rows), leaking a state into a category column.

### 2.3 Device Status is orthogonal to Active/Inactive — not a subset

`ONLINE` sits strictly inside `Active` (zero Inactive rows are ONLINE), **but** `EPF` and
`NOT REACHABLE` straddle both: Active contains 1,349 NOT REACHABLE and 477 EPF.

> Reading `ONLINE` as "the active count" understates Active by **1,826**. The two axes cannot be derived
> from each other.

### 2.4 Population boundary

**712 vehicles are `Tracking Type = '3rd P'`** with no AutoPlant device; **706** carry the vehicle
registration in `DEVICE NO` as a placeholder (all 708 non-numeric `DEVICE NO` values are SCL 650 /
PRISM 58). By design these are absent from FSM.

### 2.5 Data quality in the Excel

| Issue | Rows | Detail |
|---|---|---|
| Impossible trip dates | 23 | 20 carry years 2072–**2547**; all VBL except 3 SHREE BALAJI |
| `Reason Code` unusable | 1,505 | `0` (1,230), `1212` (9), mangled `NO TRIP␣␣␣15 DAYS` (266), plus 3,114 blank |
| State in a category column | 68 | `NDD` as a value in `Issues` |
| Dead column | 33,338 | `Remarks1` blank on every row |
| Leading zeros on `DEVICE NO` | 6,696 | Lengths 7–18 chars — must stay text |
| Header typo | — | `'Issues '` has a trailing space |
| Plant names repeat across companies | — | `OTHERS` (3 companies), `TRANSPORTER` (2) — must group on (company, plant) |
| `Zones` has both `West` and `West A`/`West B` | 86 | `West` is a **separate** zone with ZM `NA`, not a parent of West A+B |

---

## 3. Phase 2 — Excel benchmark (derived from raw rows)

Grouping: `COUNT(*)` over data rows only; `Company Name`, or the composite `(Company Name, Plant Name)`.
No summary cell was read. The sheet's Grand Total row contains the literal string `Total` in all 24
columns and **no numbers** — there was nothing in the sheet to reconcile against.

| Company | Vehicles | Deployed | Undeployed | Active | Inactive | NDD | Online | Not reach. | EPF |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| NUVISTA | 25,328 | 7,667 | 17,661 | 13,487 | 11,503 | 338 | 12,148 | 9,587 | 3,255 |
| PRISM | 2,599 | 1,249 | 1,350 | 1,527 | 716 | 356 | 1,288 | 717 | 238 |
| UTCL | 1,415 | 728 | 687 | 1,057 | 288 | 70 | 959 | 228 | 158 |
| COKE | 1,350 | 1,103 | 247 | 997 | 329 | 24 | 932 | 247 | 147 |
| SCL | 996 | 503 | 493 | 254 | 696 | 46 | 230 | 689 | 31 |
| VICAT | 878 | 526 | 352 | 609 | 258 | 11 | 566 | 204 | 97 |
| DGFC | 326 | 326 | 0 | 305 | 21 | 0 | 297 | 13 | 16 |
| SHREE BALAJI | 295 | 152 | 143 | 109 | 176 | 10 | 103 | 126 | 56 |
| VBL | 151 | 112 | 39 | 141 | 10 | 0 | 137 | 14 | 0 |
| **TOTAL** | **33,338** | **12,366** | **20,972** | **18,486** | **13,997** | **855** | **16,660** | **11,825** | **3,998** |

Per-plant benchmark (52 company-plant rows): `audit/autoplant-reconciliation/2026-08-10-excel-benchmark-by-plant.csv`.

### Consistency checks — 19 / 19 pass

At **all three levels** (grand, company, and each of the 52 company-plant pairs):

- `deployed + undeployed = total` ✔
- `active + inactive + NDD = total` ✔
- `online + not_reachable + epf + NDD = total` ✔
- `COUNT(*) = COUNT(DISTINCT vehicle)` ✔ · `COUNT(*) = COUNT(DISTINCT device)` ✔
- plants roll up to company exactly ✔ · companies roll up to grand total exactly ✔
- `Active` ≡ bucket `< 1 Day` ✔ · `NDD` ≡ blank `GPS_DATE_TIME` ✔

**The Excel side is internally sound and is a valid benchmark.**

---

## 4. Phase 3 — comparison against FSM

### 4.1 Join key

FSM mirrors 27,036 devices; the Excel lists 33,338 vehicles. Joined on **exact `DEVICE NO` ↔
`devices.device_id`** → shared population **17,593**.

> **Zero-stripping the key is a trap.** Raw exact matching already yields all 17,593 matches. Stripping
> leading zeros recovers **zero** additional matches and introduces **5 fan-out rows** by colliding
> distinct identities. Use the raw key.

Population difference is **by design**: of 15,741 Excel rows absent from FSM, **15,734 are Undeployed**.

### 4.2 GPS timestamps — the #222 offset is NOT present

Settled first, because a 5.5h shift would corrupt every recency-derived figure.

| Measure | Value |
|---|---|
| Devices with **byte-identical** timestamp in both systems | **4,494** |
| Rows near −5.5h | **1** (coincidence) |
| Median delta (FSM − Excel) | **−18 min** (consistent with the 13-min gap) |
| Max delta | 0.00h (FSM never ahead — its snapshot is earlier) |

Byte-identical agreement on 4,494 devices is **impossible under a systematic shift**. Corroborated in
code: `mapping.ts:45` → `AUTOPLANT_UTC_OFFSET_MIN = 0`. The skew guard is now two-directional
(`FUTURE_SKEW` / `IMPLAUSIBLE_PAST`) with `DEFAULT_MAX_FUTURE_SKEW_MINUTES = 60` (`mapping.ts:74`).

**#222 is fixed and verified against live data. Do not re-diagnose it as open.**

### 4.3 State classification

Population: shared vehicles that **AutoPlant itself** marks `DEPLOYED` (the source-defined operational
fleet). Δ = FSM − Excel.

| Company | Vehicles | Excel act. | FSM act. | Δ | Excel inact. | FSM inact. | Δ | Excel NDD | FSM NDD | Δ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| NUVISTA | 7,753 | 7,080 | 7,071 | −9 | 643 | 646 | +3 | 30 | 30 | 0 |
| PRISM | 1,256 | 1,079 | 1,077 | −2 | 168 | 169 | +1 | 9 | 9 | 0 |
| COKE | 1,103 | 893 | 890 | −3 | 204 | 207 | +3 | 6 | 6 | 0 |
| UTCL | 744 | 653 | 653 | **0** | 83 | 83 | **0** | 8 | 8 | 0 |
| VICAT | 526 | 492 | 493 | +1 | 34 | 33 | −1 | 0 | 0 | 0 |
| SCL | 510 | 191 | 191 | **0** | 308 | 308 | **0** | 11 | 11 | 0 |
| DGFC | 326 | 305 | 305 | **0** | 21 | 21 | **0** | 0 | 0 | 0 |
| SHREE BALAJI | 155 | 95 | 95 | **0** | 57 | 57 | **0** | 3 | 3 | 0 |
| VBL | 95 | 87 | 87 | **0** | 8 | 8 | **0** | 0 | 0 | 0 |
| **TOTAL** | **12,468** | **10,875** | **10,862** | **−13** | **1,526** | **1,532** | **+6** | **67** | **67** | **0** |

**Six of nine companies reconcile exactly on all three states. NDD reconciles exactly for all nine.**

### 4.4 Gap decomposition — closes to the unit

Against the *Excel-defined* Deployed population (before source adjudication), the gaps were
Active +79, Inactive +25, NDD −1. Every unit is accounted for:

| State | In FSM only (A) | In Excel only (B) | Reclassified in | Reclassified out | Net | Observed |
|---|---:|---:|---:|---:|---:|---:|
| Active | +110 | −24 | +2 | −9 | **+79** | +79 |
| Inactive | +18 | 0 | +9 | −2 | **+25** | +25 |
| NDD | +4 | −5 | 0 | 0 | **−1** | −1 |

Where **A** = 132 vehicles FSM counts as operational and the Excel calls Undeployed; **B** = 29 the
reverse. `A − B = 103` = the exact observed operational-population gap.

---

## 5. Phase 4 — diagnosis

### F1 · The Excel's deployment status is stale, not FSM's — 169 vehicles · high confidence

FSM and the Excel disagree on deployment status for **161** shared vehicles (using `is_departed`; 173
using `vehicles.status`). Adjudicated at `ap_masters.mst_vehicle.deployment_status`:

| | Agrees with AutoPlant |
|---|---|
| FSM | **158 / 161** |
| Excel | **2 / 161** |

Across all 17,593 shared vehicles: **FSM 99.88%, Excel 99.04%**.

- **Not a snapshot race.** Most disputed rows have a `record_updated_date` weeks old — 48 of them on
  2026-07-26. AutoPlant changed them a fortnight before the Excel was generated.
- **Not a definitional difference.** The trip-derived alternative was tested and rejected (§2.2): trip
  presence explains 91.3% of the column, `deployment_status` explains 99.04%.
- **Effect:** accounts for the entire +103 operational-population gap.
- **Residual uncertainty:** this assumes the Excel's column derives from `deployment_status`. The 99.04%
  match makes that near-certain, but a differently-defined rule for the 169 outliers is not strictly
  excluded.

### F2 · Nine "stale GPS" devices are NOT a defect — resolved · high confidence

Nine devices read Active in the Excel and Inactive in FSM, FSM's last fix 1–28 days old.
`raw_device_snapshots` settles it: **run 154 wrote exactly those old timestamps**, so AutoPlant itself
still held the old value at FSM's 14:34:55 read. All nine were pinging again by 14:48. FSM ingested
faithfully; the devices reconnected inside the 13-minute gap.

### F3 · Two boundary disagreements are the snapshot gap — resolved · certain

Two devices carry identical timestamps in both systems, aged **23.82h / 23.88h** at FSM's snapshot and
just over 24h at the Excel's. Both systems apply a 24h threshold; **both are correct at their own
instant**. (FSM: `DEFAULT_INACTIVITY_THRESHOLD_HOURS = 24`, `device-state.service.ts:11`.)

### F4 · Seven deployed vehicles wrongly excluded from the dashboard — FSM defect · high confidence

Seven vehicles AutoPlant marks `DEPLOYED` carry an open `device_departures` row, so `is_departed = true`
and they drop out of every dashboard figure.

- **Location:** `device-state.service.ts:136-139` — the `departedExists` predicate.
- **Context:** the flag is otherwise excellent — every AutoPlant `UNDEPLOYED` (5,115) and `MAINTENANCE`
  (10) vehicle is correctly warehoused. These 7 are its only false positives, out of 12,468.

### F5 · Eight live vehicles missing from FSM entirely — FSM gap · high confidence

Eight vehicles the Excel marks Deployed and actively reporting have **no row in FSM at all** —
7 NUVISTA (mostly NIMBOL) + 1 VBL; 7 ONLINE, 1 EPF.

`867542081316898` `867542081502265` `867542081467592` `867542081358619` `862491072520602`
`867542081486428` `867542081483599` `860141073288830`

### F6 · Three devices mirrored twice under two spellings — FSM defect · certain

Three physical devices appear as **two rows each** — one zero-padded, one not — on the same vehicle,
plant and company. In each case one copy is operational with GPS history and the other is a departed
phantom with none. Inflates `mirroredDevices` and `warehouseDevices` by 3.

| device_id (both spellings) | Vehicle | Company |
|---|---|---|
| `861045089202835` / `0861045089202835` | KA19AC5377 | UTCL |
| `867440065536674` / `0867440065536674` | MP19ZG9229 | Prism Cement |
| `869925073654913` / `0869925073654913` | RJ14GN4667 | Nuvista |

### F7 · Telemetry ingest is not running at its documented cadence — operational · certain

`snapshot_runs` shows a **three-day gap** (run 152 on 2026-08-07 → run 154 on 2026-08-10) against a
documented 30-minute cadence, and 2 of the last 6 runs finished `PARTIAL`. Separately, **`chunk_stats`
is null on every run**, so the skew-guard rejection tallies the reader computes
(`autoplant-source-reader.ts:105-124`) are logged but never persisted — a dropped row leaves no durable
trace, which is precisely the failure mode #222 P6 was meant to make visible.

*Caveat: this is a dev instance; the cadence gap may not reflect production.*

### F8 · FSM does not model the Device Status axis at all — coverage gap · certain

The ONLINE / NOT REACHABLE / EPF split has **no FSM counterpart**. FSM ingests `mains_status` but uses it
only for a per-ticket hint (`technical-hints.ts:90`), never as a fleet metric — so **EPF, covering 3,998
vehicles fleet-wide, is invisible on the dashboard**.

> **Polarity checked, no bug.** The two systems use *opposite* encodings: AutoPlant `mains_status = 0`
> means power failed (89.6% of those rows are EPF in the Excel), while the Excel's
> `VEHICLE POWER STATUS = 1` means the same thing. Compared literally they agree only 1.5%. FSM reads the
> AutoPlant convention and **`technical-hints.ts:90` is correct.**

---

## 6. What both systems get wrong

- **Ten test vehicles in production data** — `AUTO1998` `AUTO2388` `AUTO6528` `AUTO6531` `AUTO6877`
  `TEST1998` `TEST2388` `TEST6528` `TEST6531` `TEST6877`, all under VICAT, present in **AutoPlant, the
  Excel, and FSM's mirror**. Undeployed everywhere, so no headline count moves — but they are in the
  source of truth.
- **Twenty impossible trip dates originate upstream** (years to 2547) — an AutoPlant data-quality
  problem carried by the Excel, not a reporting one.
- **FSM's `mains_status` accepts unvalidated values** — alongside 0/1 the column holds ~18 implausible
  readings (`16351`, `24424`, `28472`, …) plus 5,959 blanks.

---

## 7. Differences vs the 2026-08-07 reconciliation

| | 2026-08-07 | 2026-08-10 (this file) |
|---|---|---|
| Excel | `SUMMARY_REPORT.xlsx`, 25,214 rows, 12 plants | `SUMMARYREPORTDeployedNEW.xlsx`, 33,338 rows, 9 companies / 52 plants |
| `Deployment Status` rule | trip-derived (all Deployed have a trip) | **master-derived**; trip rule fails (326 / 2,576 counter-examples) |
| `Issues` scope | populated only for Deployed | not confined to Deployed; also carries `NDD` |
| #222 GPS offset | open, 5.5h shift live | **fixed and verified clean** |

The two exports are **not** interchangeable. Rules derived from one must be re-verified against the other.

---

## 8. Assumptions and open questions

**Assumptions**

1. The two snapshots (13 min apart) are close enough to compare directly — confirmed by the operator.
   Two boundary cases were affected; both are accounted for in F3.
2. Company codes were mapped to FSM names **by the device-level join itself**, not by name matching. All
   nine resolved cleanly. 10 VICAT rows attach to an `R&D Testing` company in FSM.
3. Comparisons are confined to the shared population throughout. Whole-file totals are not comparable and
   were never compared.

**Open questions for the operator**

1. The Excel contradicts its own source on 169 shared vehicles. Raise with whoever generates the report,
   or is a known lag expected there?
2. Should EPF and the ONLINE / NOT REACHABLE split be surfaced in FSM? 3,998 vehicles fleet-wide have no
   dashboard representation today.
3. File F4 (7 wrongly warehoused), F5 (8 missing), F6 (3 duplicates), F7 (cadence + `chunk_stats`) as
   backlog issues?

---

## 9. Provenance

Derived from 33,338 Excel rows, 27,036 FSM `device_states` rows, and source lookups against
`ap_masters.mst_vehicle` (17,593 vehicles) and `ap_widgets.tb_vehiclemaster` (9 devices).
All AutoPlant access **read-only, SELECT only**. No FSM data or code was modified.
Interactive report: <https://claude.ai/code/artifact/a242874c-68e3-4fda-9cba-c9bc33f461a8>
