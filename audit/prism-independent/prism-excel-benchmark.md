# PRISM Excel Benchmark — Phase 1 + Phase 2 (Independent Derivation)

Source: `docs/autoplant/SUMMARY REPORT Deployed (6).xlsx`, sheet "Sheet 1".
Snapshot time (max `GPS_DATE_TIME` in the sheet): **2026-08-07 16:18:18**.
This is a **point-in-time snapshot**, not a date-ranged report — there is no reporting period to bound.

Independence note: derived only from the Excel raw rows, the FSM codebase (structure/definitions,
not query results), and the AutoPlant data-dictionary docs under `docs/autoplant/`. `audit/` and
`.scratch/` were not read.

## Phase 1 — What the sheet is

- One visible sheet, 2,584 data rows + 1 footer row where every cell literally reads `"Total"` (a
  label row, not a computed grand total — **excluded** from all counts below). Real row count: **2,583**.
- Zero formulas anywhere in the workbook (`data_only=False` scan, 0 formula cells) — this is a flat
  export. Every rule below is inferred from row-level data, not read off a formula.
- Every real row has `Company Name = PRISM`, `Plant Name = SATNA_PLANT`, `Zones = East A`. Single
  company, single plant, single zone — not a multi-plant rollup.
- Grain: **one row per device** (equivalently, one row per vehicle — see uniqueness below).

**Business-rule definitions (inferred, not read from a formula):**

| Column | Values | Definition |
|---|---|---|
| `Deployment Status` | Deployed / Undeployed | AutoPlant's own current deployment status for the vehicle-device pairing. Independent axis from `Active_Inactive`. |
| `Active_Inactive` | Active / Inactive / **NDD** | **Three peer states.** `Active` = last GPS ping < 24h before snapshot time. `Inactive` = last ping ≥ 24h before snapshot time (any age). `NDD` ("No Data Detected", confirmed by user) = device has **never** reported — `GPS_DATE_TIME` is NULL for 100% of the 356 NDD rows. NDD is not a subset of Inactive; conflating them would silently misstate both counts. |
| `Bucket By Days` | `< 1 Day`, `(01-02)`, `(03-07)`, `(08-15)`, `(16-30)`, `> 30 Days`, `NDD` | Recency bucket derived from the same last-ping age as `Active_Inactive`. Boundaries verified numerically against `GPS_DATE_TIME`: buckets partition cleanly on day boundaries with no overlap (e.g. `(01-02) Days` spans exactly `[1.0047, 1.9857]` days). `NDD` bucket = the 356 never-reported rows. |
| `Device Status` | ONLINE / NOT REACHABLE / EPF / NDD | Raw connectivity/comm status. `NDD` here is a 1:1 match (356=356) with `Active_Inactive=NDD`. `ONLINE` is always `Active` (1,265/1,265). `NOT REACHABLE` and `EPF` both split across `Active` **and** `Inactive` — so `Device Status` alone does not determine `Active_Inactive`; the 24h ping-age rule does. |
| `Issues` / `Reason Code` / `Remarks1` | — | Out of scope per user instruction (`Issues` not to be used for this reconciliation). `Remarks1` is 100% blank (dead column). |

**Safe keys:** `VEHICLE NO` and `DEVICE NO` are both 100% unique across the 2,583 rows (0 duplicates
each) — safe join/group keys, and confirm the one-row-per-device/vehicle grain. `IMSI_NO` has 497
duplicates — **not** safe as a key.

## Phase 2 — Derived reference table

All figures below are counts of raw Excel rows for PRISM / SATNA_PLANT, snapshot 2026-08-07.

### Top-level

| Metric | Value |
|---|---|
| Total devices (all rows) | **2,583** |
| Deployed | **1,240** |
| Undeployed | **1,343** |
| Active (< 24h) | **1,530** |
| Inactive (≥ 24h) | **697** |
| NDD (never reported) | **356** |

### Deployment Status × Active_Inactive (full cross-tab)

| | Active | Inactive | NDD | **Row total** |
|---|---|---|---|---|
| **Deployed** | 1,048 | 177 | 15 | **1,240** |
| **Undeployed** | 482 | 520 | 341 | **1,343** |
| **Column total** | 1,530 | 697 | 356 | **2,583** |

### Device Status (all rows)

| Status | Count |
|---|---|
| ONLINE | 1,265 |
| NOT REACHABLE | 720 |
| EPF | 242 |
| NDD | 356 |

### Device type (all rows / Deployed-only)

| Device type | All rows | Deployed only |
|---|---|---|
| NVT3 | 1,217 | 742 |
| NVT180 | 414 | 270 |
| V5 | 323 | 148 |
| VT200L | 64 | 43 |
| #NVT | 126 | 8 |
| VENDOR_GPS | 54 | 3 |
| GV30CIN | 17 | 11 |
| (blank) | 368 | 15 |

## Consistency checks (all passed)

- `Deployed (1,240) + Undeployed (1,343) = 2,583` ✓ matches total row count.
- `Active (1,530) + Inactive (697) + NDD (356) = 2,583` ✓ matches total row count (would silently
  under-count by 356 if NDD were dropped as "not a real category").
- Cross-tab row/column margins both reconcile to 2,583 ✓.
- `COUNT(*) == COUNT(DISTINCT VEHICLE NO) == COUNT(DISTINCT DEVICE NO) == 2,583` ✓ — no fan-out,
  confirmed one-row-per-device grain.
- No grand-total row exists in the sheet to cross-check against (the footer row is a text label, not
  a sum) — the internal cross-tab margin checks above are the only available validation, and they hold.

## Open structural question carried into Phase 3

`master-mapping.ts` (`OPERATIONAL_DEPLOYMENT_STATUSES = ['DEPLOYED', 'ACTIVE']`, lines 129-152) shows
FSM's master sync **only ever inserts** a vehicle/device row when its AutoPlant `deployment_status` is
`DEPLOYED` or `ACTIVE` — a never-deployed (`UNDEPLOYED`-since-forever) row is read, counted, and
deliberately dropped, never created in FSM's `vehicles`/`devices` tables (explicit operator decision,
2026-07-17, to avoid the mirror growing from ~21k operational to ~48.5k full AutoPlant catalog). The
mirrored `status` field DOES get updated on re-sync, so a device that was once Deployed and later went
Undeployed can still be present with `status = UNDEPLOYED`. This means FSM's total mirrored device count
for SATNA_PLANT is **not expected to equal 2,583** by design, and is not simply "1,240" either (it could
be somewhat higher, for previously-deployed devices that later went idle). Phase 3 needs to establish
FSM's actual mirrored population before any total-count comparison is meaningful — see the
reconciliation report.
