# Phase 2 — Excel Derived Benchmark (ground truth)

Source: `docs/autoplant/SUMMARY_REPORT.xlsx`, sheet `Sheet 1`, **25,214 raw data rows**
(rows 2–25215). Row 25216 `Grand Total` is excluded — see *Caveats*.

Every figure below is derived by grouping the **raw rows**. No summary cell, subtotal or
pre-computed block was used as input. Workbook contains **zero formulas** — it is a flat export,
so all business rules are inferred from the data and stated explicitly.

**Snapshot anchor:** `max(GPS_DATE_TIME) = 2026-08-07 06:49:21` (IST). The report was generated
between `06:49:10` and `06:50:47` IST on 2026-08-07 — bracketed by the `< 1 Day` / `(01-02) Days`
boundary. Every Active/Inactive figure is relative to that instant.

## Column semantics (derived, all verified against row counts)

| Column | Meaning | Verified by |
|---|---|---|
| `Active_Inactive` | **Active** = GPS age < 24h · **Inactive** = GPS age ≥ 24h · **NDD** = no GPS at all. NDD is a **third state, not a flavour of Inactive**. | `Active` ≡ bucket `< 1 Day` (13,429 both); `NDD` ≡ blank `GPS_DATE_TIME` (343, identical row sets) |
| `Bucket By Days` | GPS-age partition. True boundaries are **1, 2, 7, 15, 30 days** — the labels `(03-07)`/`(08-15)` are off-by-one vs the data they hold (`(03-07)` actually holds ages 2–7d). | min/max age per bucket, zero overlap |
| `Device Status` | Precedence: **NDD** (no GPS) → **EPF** (`VEHICLE POWER STATUS = 1`) → **ONLINE** (GPS age ≤ ~60 min) → **NOT REACHABLE**. | EPF ≡ power=1 (3,237 exact); ONLINE max age 62.8 min vs NOT REACHABLE min 63.4 min — **zero overlap** |
| `Deployment Status` | Deployed = vehicle has a current trip. `trip_created_date_IST` non-blank ⊇ Deployed. | all 7,650 Deployed have a trip date; `Shift='NA'` ≡ no trip (15,467) |
| `Issues ` (note trailing space) | Populated **only for Deployed** rows. `SE Issue` never occurs on `ONLINE`. | non-blank count 7,650 ≡ Deployed exactly; SE Issue = 77 NOT REACHABLE + 34 EPF |
| `Zones` / `Zonal Manager` | Deterministic function of `Plant Name` (12 plants → 4 zones). | 1:1 verified, no plant maps to two zones |

## Benchmark table

| Metric | ARASMETA | BIHAR | CHITTOR | HARYANA | JOJOBERA | MEJIA | NIMBOL | ODISHA | OTHERS | PANAGARH | RISDA | SONADIH | **NUVISTA** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Total vehicles (= devices) | 1,309 | 1,071 | 4,075 | 1,017 | 1,133 | 421 | 5,100 | 1,268 | 170 | 1,015 | 7,685 | 950 | **25,214** |
| Deployed | 356 | 176 | 1,272 | 400 | 732 | 326 | 1,258 | 217 | 130 | 506 | 1,823 | 454 | **7,650** |
| Undeployed | 953 | 895 | 2,803 | 617 | 401 | 95 | 3,842 | 1,051 | 40 | 509 | 5,862 | 496 | **17,564** |
| Active | 659 | 358 | 2,391 | 475 | 777 | 338 | 2,778 | 474 | 137 | 628 | 3,742 | 672 | **13,429** |
| Inactive | 637 | 701 | 1,665 | 532 | 354 | 83 | 2,241 | 748 | 19 | 384 | 3,806 | 272 | **11,442** |
| NDD (no device data) | 13 | 12 | 19 | 10 | 2 | 0 | 81 | 46 | 14 | 3 | 137 | 6 | **343** |
| Device Status = ONLINE | 577 | 302 | 2,124 | 411 | 713 | 313 | 2,474 | 415 | 130 | 585 | 3,230 | 598 | **11,872** |
| Device Status = NOT REACHABLE | 475 | 631 | 1,423 | 328 | 378 | 95 | 2,014 | 667 | 6 | 380 | 3,088 | 277 | **9,762** |
| Device Status = EPF | 244 | 126 | 509 | 268 | 40 | 13 | 531 | 140 | 20 | 47 | 1,230 | 69 | **3,237** |
| Device Status = NDD | 13 | 12 | 19 | 10 | 2 | 0 | 81 | 46 | 14 | 3 | 137 | 6 | **343** |
| Issue = CS Issue | 353 | 175 | 1,268 | 395 | 721 | 326 | 1,193 | 211 | 116 | 503 | 1,800 | 446 | **7,507** |
| Issue = SE Issue | 2 | 1 | 4 | 3 | 11 | 0 | 56 | 5 | 3 | 3 | 17 | 6 | **111** |
| Issue = NDD | 1 | 0 | 0 | 2 | 0 | 0 | 9 | 1 | 11 | 0 | 6 | 2 | **32** |
| Deployed & Active | 330 | 163 | 1,209 | 339 | 680 | 308 | 1,146 | 201 | 105 | 486 | 1,629 | 425 | **7,021** |
| Deployed & Inactive | 25 | 13 | 63 | 59 | 52 | 18 | 103 | 15 | 14 | 20 | 188 | 27 | **597** |
| Bucket < 1 Day | 659 | 358 | 2,391 | 475 | 777 | 338 | 2,778 | 474 | 137 | 628 | 3,742 | 672 | **13,429** |
| Bucket (01-02) Days | 10 | 13 | 55 | 15 | 23 | 9 | 53 | 13 | 2 | 13 | 117 | 18 | **341** |
| Bucket (03-07) Days | 37 | 14 | 73 | 38 | 34 | 7 | 83 | 27 | 13 | 22 | 248 | 15 | **611** |
| Bucket (08-15) Days | 29 | 17 | 50 | 36 | 23 | 4 | 67 | 18 | 3 | 13 | 159 | 10 | **429** |
| Bucket (16-30) Days | 87 | 56 | 110 | 29 | 35 | 7 | 200 | 51 | 1 | 36 | 384 | 41 | **1,037** |
| Bucket > 30 Days | 474 | 601 | 1,377 | 414 | 239 | 56 | 1,838 | 639 | 0 | 300 | 2,898 | 188 | **9,024** |
| Bucket NDD | 13 | 12 | 19 | 10 | 2 | 0 | 81 | 46 | 14 | 3 | 137 | 6 | **343** |

*(`DISTINCT VEHICLE NO` and `DISTINCT DEVICE NO` equal `Total` for every plant — omitted for width.)*

## Consistency checks — 110 assertions, **0 failures**

| Check | Scope | Result |
|---|---|---|
| `Deployed + Undeployed = Total` | 12 plants + company | PASS |
| `Active + Inactive + NDD = Total` | 12 plants + company | PASS |
| `ONLINE + NOT REACHABLE + EPF + NDD = Total` | 12 plants + company | PASS |
| `CS + SE + NDD issues = Deployed` | 12 plants + company | PASS |
| `COUNT(*) = COUNT(DISTINCT vehicle) = COUNT(DISTINCT device)` | 12 plants + company | PASS — **no duplicates anywhere** |
| Plants roll up to company (all 24 metrics) | 24 metrics | PASS |
| `Active = bucket '< 1 Day'` | company | PASS (13,429) |
| `Inactive = Σ(inactive buckets)` | company | PASS (11,442) |

## Caveats and data-quality flags

1. **The sheet's `Grand Total` row carries no numbers.** Row 25216 is merged `A:X` and contains the
   literal string `Total` in all 24 cells. There is therefore **no in-sheet total to cross-check the
   derivation against** — the roll-up checks above are the substitute.
2. **`IMSI_NO` is not a valid key.** 23,596 non-blank / 23,566 distinct → 8 duplicated values,
   including `899192250` repeated **23 times** (9 digits — not a real 15-digit IMSI). 1,618 blank.
   `VEHICLE NO` and `DEVICE NO` are both perfectly unique and are the only safe join keys.
3. **4,715 `DEVICE NO` values carry leading zeros** (lengths 14/15/16/18, e.g. `0359688090225110`).
   Any numeric cast drops/corrupts them. `source-reader.ts` already documents this hazard.
4. **`Reason Code` is unreliable as a category** — 23,475 rows say `NO TRIP > 15 DAYS` including
   5,450 rows that are *Active with a CS Issue*, and 520 rows say the literal `0`. 1,219 blank.
5. **`Remarks1` is 100% empty**; `Company Name`, `Vehicle Type`, `Tracking Type` are single-valued
   (`NUVISTA` / `DEDICATED` / `AP`) — no discriminating power.
6. **Plant `OTHERS` (170 rows)** is the catch-all: zone `NA`, manager `NA`. Likely excluded or
   mapped differently by FSM — a prime candidate for an off-by-170 discrepancy.
