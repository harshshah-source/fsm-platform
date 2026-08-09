# PRISM Reconciliation Report — Independent Read

Date: 2026-08-07 · Scope: **PRISM only** (Excel: company `PRISM`, plant `SATNA_PLANT`, zone `East A`).
Tolerance: **exact match** (per operator instruction).

Sources used: the ground-truth Excel, the FSM codebase, FSM Postgres (`localhost:5433`), and
AutoPlant production MySQL (`SELECT` only). `audit/` and `.scratch/` were **not read** — this is an
independent derivation. No FSM source was modified; no sync was run; no data was written.

## TL;DR

PRISM **does not reconcile**, and the two largest causes are defects in FSM, not in the Excel.

1. **FSM shifts every GPS ping 5.5 hours into the past** (`mapping.ts:15`). AutoPlant's
   `latest_gps_datetime` is stored in **UTC**, but FSM normalizes it as if it were IST wall-clock.
   Fleet-wide this falsely marks **434 devices inactive** that are not. Confidence: **high** — verified
   against the live source and independently re-validated on a second company's plant.
2. **A device that has never reported is counted as healthy.** Fleet-wide, **913 never-reported
   devices** sit in `healthyOperational`. The Excel treats this as a distinct third state (`NDD`).
   Confidence: **high**.
3. **A scope difference by design:** FSM never mirrors never-deployed vehicles, so 1,034 of the
   Excel's rows structurally cannot exist in FSM. This is intended behaviour, not a bug — but it means
   total-count comparisons between the two are invalid and must never be presented as a discrepancy.

---

## Part 1 — Population: the two systems do not measure the same set

**The Excel's `SATNA_PLANT` is not one plant.** No plant of that name exists in `mst_plant` or
`tb_vehiclemaster`. The Excel's 2,583 rows resolve to AutoPlant **`plant_id` 3121 + 3122**
(`SATNA PLANT LINE 1` and `SATNA PLANT LINE 2`), which FSM correctly mirrors as **two separate
plants** (`plant_id` 18 and 19). Any per-plant comparison must sum FSM's two rows to face the Excel's
one. *(This is a reporting-label difference, not an FSM defect.)*

| Population | Count | Basis |
|---|---|---|
| AutoPlant raw (`plant_id` 3121+3122) | 2,819 | `COUNT(*) FROM tb_vehiclemaster` |
| **Excel (ground truth)** | **2,583** | raw rows, footer label excluded |
| **FSM (`device_states`, plants 18+19)** | **1,619** | `COUNT(*) FROM device_states` |
| Devices in BOTH | 1,549 | matched on `device_id` |
| In Excel, absent from FSM | **1,034** | **100% `Undeployed`** |
| In FSM, absent from Excel | 70 | 45 DEPLOYED · 14 UNDEPLOYED · 11 MAINTENANCE |

**Every one of the Excel's 2,583 devices exists in AutoPlant** (0 missing) — the Excel invents
nothing, and there is no raw-row-level disagreement between the Excel and the database.

### Why 1,034 Excel devices are absent from FSM — by design, not a bug

`master-mapping.ts:129-152` gates **inserts** on
`OPERATIONAL_DEPLOYMENT_STATUSES = ['DEPLOYED','ACTIVE']`. A vehicle that has never been deployed is
read, counted, and deliberately dropped — an explicit operator decision (2026-07-17) to stop the
mirror growing from ~21k operational to the ~48.5k full source catalog. The `update` set *does*
mirror `status`, so a device that was once deployed and later went idle survives with
`status = UNDEPLOYED` — which is why FSM holds 309 Undeployed devices rather than zero.

**Consequence:** `Excel total (2,583)` vs `FSM total (1,619)` is **not a defect and must not be
reported as one.** The two figures answer different questions. Only the shared population is a valid
basis for judging FSM's calculations.

### Why 236 AutoPlant rows are absent from the Excel

The Excel export filters out (measured, not assumed):

| Rule | Rows | Confidence |
|---|---|---|
| `hierarchy_path`/`FIRST_INSTALLED_COMPANY_ID` = `1000` (Autoplant's own internal company, not PRISM) | 52 | high — 0 such rows are included |
| `REMARKS = 'NOT ON TIME'` | 156 | high — 156 excluded, 0 included |
| **Unexplained** | **28** | — see open questions |

The residual 28 are not explained by installation remark, deployment status, device type, vendor, or
recency. I could not derive a rule and have not invented one.

---

## Part 2 — Metric comparison

### 2a. Headline figures as each system reports them

FSM figures are `FLEET_COUNT_COLUMNS` (`dashboard.service.ts:38-43`) — the exact fragment behind the
Dashboard KPI strip, the Company/Plant table, the zone table, and (via the same predicates) the Ops
Explorer `plants` dataset.

| Metric | Excel (derived) | FSM (plants 18+19) | Δ | Comparable? |
|---|---|---|---|---|
| Total devices | 2,583 | 1,619 | −964 | ❌ different populations by design |
| Deployed | 1,240 | 1,241¹ | +1 | ⚠ near-match on shared rows |
| Undeployed | 1,343 | 309 | −1,034 | ❌ insert gate |
| Inactive | **697** | **214** | **−483** | ❌ population + defects |
| Active / healthy | 1,530 | 1,044 | −486 | ❌ population + defects |
| NDD (never reported) | **356** | **no such concept** | — | ❌ **defect — see F2** |
| Warehouse / departed | no such concept | 361 | — | FSM-only dimension (legitimate) |

¹ On the 1,549 shared devices, Excel `Deployed` (1,240) vs FSM `vehicle_status` DEPLOYED (1,241)
— agreement is essentially exact, and `ACTIVE`+`DEPLOYED` → "Deployed" maps cleanly.

**Reconciled ✓:** deployment-status semantics, device identity/grain (`device_id` unique on both
sides, no fan-out), and the 24-hour inactivity threshold itself — FSM's
`inactivity_threshold_hours = 24` matches the rule I derived independently from the Excel's
`Bucket By Days` boundaries.

### 2b. The decisive test — shared population only

Restricting to the **1,549 devices both systems hold** isolates *calculation* error from *scope*
difference. Of these, 1,231 are FSM-non-departed with a clean Excel verdict:

| | FSM says healthy | FSM says inactive |
|---|---|---|
| **Excel says Active** | 1,030 ✓ | **24 ✗** |
| **Excel says Inactive** | 0 ✓ | 177 ✓ |

- **0 devices** the Excel calls Inactive are called healthy by FSM — FSM never *misses* a genuinely
  dead device. Good.
- **24 devices** the Excel calls Active, FSM calls inactive — all false positives. Root cause below.

---

## Part 3 — Root causes

### F1 · FSM shifts every GPS timestamp 5.5 hours into the past — **CONFIRMED, high confidence**

**Location:** `apps/backend/src/ingestion/autoplant/mapping.ts:15`
→ `apps/backend/src/ingestion/normalize.ts:32`

```ts
// mapping.ts:14-15
/** AutoPlant source timestamps are naive IST (+330). */
export const AUTOPLANT_UTC_OFFSET_MIN = 330;

// normalize.ts:30-32 — subtracts the offset
const asIfUtcMs = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss);
return new Date(asIfUtcMs - sourceUtcOffsetMinutes * 60_000);
```

**The premise is no longer true.** `mapping.ts:17-30` documents a live verification on **2026-07-17**
showing `latest_gps_datetime` tracking IST. Re-measured today against the same production source:

| Probe | Value |
|---|---|
| `@@system_time_zone` | **`UTC`** |
| `NOW()` vs `UTC_TIMESTAMP()` | identical, `TIMESTAMPDIFF = 0` |
| `MAX(latest_gps_datetime)` for 3121+3122 | `2026-08-07 11:20:52` |
| Real wall clock at that moment | `16:51 IST` = `11:21 UTC` |

The freshest ping tracks **UTC**, not IST. The source's behaviour changed between 2026-07-17 and
2026-08-07. The `+330` normalization — correct when written — now subtracts 5.5h from an
already-UTC value.

**Measured proof (driver artifacts eliminated by fetching both sides as formatted strings; the Node
process runs in `Asia/Calcutta`, which silently corrupts naive-DATETIME reads):**

| Comparison | Result |
|---|---|
| Excel − AutoPlant(raw) | max **+5.5000h**, modal **+5.5h** → Excel correctly renders UTC→IST ✓ |
| AutoPlant − FSM(stored UTC) | min **+5.5000h**, median +6.81h → FSM is 5.5h behind ✗ |
| AutoPlant − FSM(rendered IST) | min **0.0000h**, 32.3% exactly zero → confirms the double-conversion |

The residual above the 5.5h floor (~1.3h median) is ordinary ingestion lag, a separate and much
smaller effect.

**Independent second-entity validation** (required before trusting a tuned result) — plant
`RCP-9211`, company **Nuvista**, a different company and plant from the one used to find the bug:

- 2,435 matched devices · min delta **exactly 5.5000h** · 557 devices at exactly 5.5h
- **0 devices with a delta below 5.5h** ← the falsification test. If FSM's handling were correct,
  freshly-ingested devices would sit near 0. None do. The floor is hard.

**Why it fails silently:** the guard at `mapping.ts:168` only rejects timestamps *ahead* of now. An
error that pushes timestamps into the *past* sails through, and every unit test constructs its own
input rather than reading the live source, so nothing catches a source-side change.

**Impact — this is the main event:**

| | PRISM (18+19) | **Fleet-wide** |
|---|---|---|
| Operational devices | 1,258 | 15,696 |
| Currently counted inactive | 214 | **2,675** |
| Inactive with the shift backed out | 192 | **2,241** |
| **Falsely inactive** | **22** | **434** |

**≈16% of the entire inactive queue is fabricated.** Every device silent 18.5–24h is misclassified.
Because `sla_bucket` derives from the same inflated `inactivity_hours`, severity bands are inflated
too, so this propagates into ticket creation, the recommender's priority ordering, SLA reporting, and
Fleet Uptime.

**Validation that this is the right fix:** applying +5.5h to the shared population cuts
Excel-vs-FSM disagreements from **24 → 6**. Of the 6 residuals: 4 are genuine ingestion lag (FSM has
not received a recent ping at all) and 2 are threshold-boundary cases at 23.8/23.9h corrected, where
the Excel's later reference time legitimately pushed them past 24h. **This is a partial fix, not a
complete one** — it resolves the systematic error, and a separate ingestion-freshness question
remains.

### F2 · Never-reported devices are counted as healthy — **CONFIRMED, high confidence**

**Location:** `apps/backend/src/dashboard/dashboard.service.ts:43`

```sql
COUNT(*) FILTER (WHERE ds.is_departed = false
  AND NOT (ds.is_inactive = true AND ds.sla_bucket IS NOT NULL))::int AS "healthyOperational"
```

`healthy` is defined as *"not departed and not inactive."* A device that has never pinged has
`latest_gps_datetime = NULL` → `inactivity_hours = NULL` → `is_inactive = false` → it falls through
into **healthy**. This is the NULL-handling trap: absence of evidence is read as evidence of health.

Verified on all 24 NDD devices FSM holds for Satna: `latest_gps_datetime` is NULL in **both** FSM and
AutoPlant (FSM mirrors the absence correctly — the defect is purely in the counting), `is_inactive`
is `false` for all 24, and the 10 non-departed ones land in `healthyOperational`.

**Impact: 913 never-reported devices are counted as healthy fleet-wide.** The Excel gets this right,
treating `NDD` as a peer third state — and note that `active + inactive` alone does *not* equal the
Excel's total; only `active + inactive + NDD` does. FSM has no representation of this state at all,
so it cannot express the distinction even in principle without a schema/semantic change.

### F3 · The `SATNA_PLANT` label collapses two real plants — reporting difference, **not an FSM defect**

FSM is arguably *more* correct here: AutoPlant's own master holds them as two plants (3121, 3122) and
FSM mirrors that faithfully. The Excel's single label is a denormalized reporting name from
`tb_vehiclemaster`. Flagged only because any naïve per-plant join between the two will silently
mismatch.

---

## Part 4 — What the Excel and FSM *both* get wrong

**One candidate: neither system distinguishes "device removed to warehouse" from "device broken."**
FSM has the concept (`is_departed`, 361 devices at Satna) and correctly excludes them from both
healthy and inactive. The Excel has no such column, so those 361 devices are spread across its
`Active` (178), `Inactive` (116) and `NDD` (14) counts. For the specific question *"how many devices
need an engineer?"*, the Excel's `Inactive = 697` therefore **overstates** the actionable population
by up to 116 warehouse units. The Excel remains ground truth for *"what is AutoPlant reporting"*; it
is not ground truth for *"what needs fixing in the field."*

Beyond that I found **no case** where the Excel is wrong. Its `Active/Inactive/NDD` split, its 24h
threshold, its day-buckets, and its UTC→IST conversion are all internally consistent and correct
against the raw source.

---

## Part 5 — Assumptions and open questions

**Assumptions (stated, not verified):**

1. **The FSM database I queried is `localhost:5433`**, not a production FSM host. Its shape is
   realistic (15,696 operational devices, real company names), but **every FSM-side figure in this
   report should be re-confirmed against production FSM** before action. This is the single biggest
   caveat here.
2. AutoPlant's `tb_vehiclemaster` is the Excel's source. Inferred from a near-1:1 column
   correspondence, not from an export definition I was shown.
3. The Excel's reference "now" is its own newest ping (`2026-08-07 16:18:18 IST`). Its
   Active/Inactive boundary is self-consistent under that assumption.
4. `CS Issue` / `SE Issue` were excluded per your instruction and play no part in any figure here.

**Questions I need you to answer:**

1. **Was the AutoPlant source change to `latest_gps_datetime` (IST → UTC, between 2026-07-17 and
   2026-08-07) announced?** If AutoPlant changed it deliberately, the fix is a one-line constant. If
   it changed *silently*, the more important question is what else changed — and FSM needs a
   source-contract monitor, because nothing in the current test suite could have caught this.
2. **Should never-reported (NDD) devices be their own state in FSM?** They are currently invisible —
   counted as healthy. This needs a product decision, not just a query fix.
3. **What are the 28 Excel-excluded rows?** I could not derive a rule and refuse to guess one.
4. **Is the ~1.3h median ingestion lag expected?** The telemetry tick is documented as 30 minutes.
5. Do you want the two Satna lines presented as one combined "SATNA_PLANT" figure anywhere in FSM's
   UI, to match how the business reads this Excel?

**Not done, deliberately:** no FSM source modified, no sync run, no data written, nothing outside
`audit/prism-independent/` touched. All proposed changes are in `corrected-queries.sql` as proposals
only.
