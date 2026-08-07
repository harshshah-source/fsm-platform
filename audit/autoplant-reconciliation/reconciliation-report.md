# AutoPlant ↔ FSM Reconciliation Report

**Date:** 2026-08-07 · **Ground truth:** `docs/autoplant/SUMMARY_REPORT.xlsx` (25,214 rows, NUVISTA,
snapshot 2026-08-07 06:49 IST) · **FSM:** local Postgres mirror, master-sync run 113 / snapshot run 151
(both finished 2026-08-07 01:42–01:45 UTC = 07:12–07:15 IST) · **Method:** device-level join on
`DEVICE NO` ↔ `device_states.device_id`, not aggregate comparison.

Timing is effectively aligned — FSM's sync finished **23 minutes after** the Excel was generated.

---

## 0. Scope — read this before any number below

The Excel and the FSM dashboard do **not** measure the same population, and no amount of query
fixing will make their totals equal.

| | Excel | FSM (Nuvista) |
|---|---:|---:|
| Devices | 25,214 | 11,886 |
| Shared (joined on device id) | **11,624** | **11,624** |
| In Excel, absent from FSM | **13,590** | — |
| In FSM, absent from Excel | — | **262** |

**13,581 of the 13,590 absent devices (99.93%) are `Undeployed` in the Excel.** That is FSM working
as specified: the #128 *insert-scope pin* (`master-mapping.ts:131-144`) mirrors only vehicles seen in
`OPERATIONAL_DEPLOYMENT_STATUSES = ['DEPLOYED','ACTIVE']`. A never-deployed vehicle is counted and
dropped, never inserted — a decision recorded in INDEX.md ("or `vehicles` balloons ~21k→~48k and every
dashboard total changes meaning").

**Consequence:** any Excel-vs-FSM comparison of *totals* is meaningless. Everything below is computed
on the 11,624 shared devices, where comparison is valid.

Company scoping is clean: **zero** Excel devices appear under a different FSM company.

---

## 1. What already reconciles

| Metric | Excel | FSM | Agreement |
|---|---|---|---|
| **Deployment status** (`Deployment Status` ↔ `vehicles.status`) | 7,641 Dep / 3,983 Undep | 7,638 / 3,932 | **99.54%** (11,570 / 11,624) |
| **Plant mapping** (22 FSM plant codes → 12 Excel names) | 12 names | 22 codes | **100.0%** — every FSM plant maps to exactly one Excel plant, no splits |
| **Company attribution** | NUVISTA | Nuvista (id 4) | **100%** — 0 leakage |
| **Active/Inactive** (`Active_Inactive` ↔ `is_inactive`) | 13,429 / 11,442 | — | **95.0%** (11,039 / 11,624) |
| **Identity** | 25,214 distinct | 11,886 distinct | no duplicates on either side |

`vehicles.status` is a faithful mirror of `mst_vehicle.deployment_status`. **The Excel's
`Deployment Status` column is that same field** — confirmed empirically, not assumed.

Plant mapping (each 100% clean): `RCP-9211|RCP-5151|RCP_NVL_HUB→RISDA` · `NCP-9117→NIMBOL` ·
`CCP-9115|CCP-9236→CHITTOR` · `JCP-9105|JCP-9234→JOJOBERA` · `HCP-9116→HARYANA` ·
`PCP-5150|PCP-9214→PANAGARH` · `ACP-9106|ACP-9231→ARASMETA` · `SCP-9232|SCP-9104→SONADIH` ·
`OCP-5152|OCP-9215→ODISHA` · `MCP-9233|MCP-9107→MEJIA` · `BCP-5153|BCP-9216→BIHAR` ·
`SURAT CEMENT PLANT→OTHERS`.

---

## 2. Mismatches, by impact

### F1 — `is_departed` has drifted from `vehicles.status` · **3,153 devices (27.1%)** · confidence **HIGH**

The single largest defect. Two fields written from the same source by the same sync now disagree.

| `vehicles.status` | `is_departed` | n | Meaning |
|---|---|---:|---|
| DEPLOYED | false | 6,934 | correct |
| UNDEPLOYED | true | 1,537 | correct |
| **UNDEPLOYED** | **false** | **2,398** | undeployed vehicle counted as operational |
| **DEPLOYED** | **true** | **755** | **live vehicle sitting in "warehouse"** |

**Impact on the dashboard**, measured against Excel ground truth on shared devices:

```
Excel says Deployed                       7,641
FSM operationalDevices (is_departed=false) 9,332
net overstatement                         +1,691   (+22.1%)
gross misclassification                    3,199   (27.5%)
```

`operationalDevices` is **the denominator for every rate on the dashboard** (`kpi-definitions.md`
§3), so Inactive % and Fleet Health % are wrong at every level for this company.

The 755 DEPLOYED-but-departed devices are the more dangerous half: departed devices are excluded
from inactivity, SLA bucketing, ticket creation and dispatch **by design**. These are live,
pinging vehicles that FSM has made invisible to field operations.

**Root cause — partially established.** `vehicles.status` is written verbatim on every sync for
known vehicles (`master-sync.service.ts:256-257`). `is_departed` is denormalised from
`device_departures` by `DeviceStateService.recompute`. The allow-list
`OPERATIONAL_DEPLOYMENT_STATUSES` is supposed to drive both. I have **not** isolated which side
fails — the most likely candidate is auto-restore not closing `device_departures` rows when a
vehicle returns to DEPLOYED. *Confidence on the discrepancy: HIGH (directly measured). Confidence on
the mechanism: MEDIUM — needs the `device_departures` ledger examined.*

**This is platform-wide, not a Nuvista artefact.** The same drift, measured across every company
with >300 mirrored devices — none of which was used to develop the finding:

| Company | Mirrored | Live hidden in warehouse | Undeployed counted operational | Drift |
|---|---:|---:|---:|---:|
| Vedanta - ESL | 646 | 218 | 101 | **49.4%** |
| Vasavadatta | 2,181 | 715 | 0 | **32.8%** |
| UTCL | 3,118 | 82 | 920 | **32.1%** |
| Nuvista | 11,886 | 795 | 2,438 | **27.2%** |
| SAURASHTRA CEMENT | 660 | 56 | 97 | 23.2% |
| Prism Cement | 1,809 | 102 | 240 | 18.9% |
| Vicat Cement | 695 | 40 | 44 | 12.1% |
| Deepak Fertilizer | 1,531 | 107 | 6 | 7.4% |
| Zuari Cement | 339 | 6 | 18 | 7.1% |
| HCCB | 1,325 | 43 | 37 | 6.0% |
| DGFC | 360 | 0 | 15 | 4.2% |
| STAR CEMENT | 987 | 0 | 0 | **0.0%** |

Vasavadatta drifts in one direction only (715 hidden, 0 over-counted) while UTCL drifts almost
entirely the other (82 / 920), and STAR CEMENT is perfectly clean. A single uniform bug would not
produce that pattern — it points to per-company differences in departure/restore history rather than
one bad predicate.

### F2 — FSM telemetry is ~5.1 h stale · **all 11,578 devices** · confidence **HIGH**

Per-device GPS delta (both sides normalised to UTC — the Excel's `GPS_DATE_TIME` is naive IST):

```
min -5.50h · p05 -5.50h · p25 -5.15h · p50 -5.10h · p75 -5.10h · p95 -5.05h
99.5% of devices older by >1h · only 2 of 11,578 within ±5 min of zero
```

This is **not** a timezone bug — I tested that and ruled it out. The offset is ~5.1 h, not the
5 h 30 m an IST double-conversion would produce, and the distribution has a positive tail. FSM's
conversion is correct; its *data* is old. Snapshot run 151 completed at 07:15 IST yet the freshest
GPS in `device_states` is 01:44 IST, so this is not simply "no run since" — run 151 took 3m19s
against run 149's 9 minutes, suggesting an incomplete pass.

**Proof of harm:** 80 devices are Active in the Excel but `is_inactive = true` in FSM. Their *true*
GPS age from the Excel is **18.2 h – 24.0 h** — exactly the window where adding a +5.1 h bias crosses
the 24 h threshold. Every one is a false inactive: a spurious SLA breach and a potential auto-created
ticket against a healthy device.

> Side observation, unverified: `raw_device_snapshots` has daily partitions only through
> `y2026m07d11`; August rows are landing in `_default`. Possibly related to the stalled ingest,
> possibly unrelated — flagging, not claiming.

### F3 — NDD devices are counted as healthy · **46 devices** · confidence **HIGH** (mechanism)

`healthyOperational` is defined as the *negation* of inactive:

```sql
COUNT(*) FILTER (WHERE ds.is_departed = false
                   AND NOT (ds.is_inactive = true AND ds.sla_bucket IS NOT NULL))
```

A device that has **never reported GPS** (`latest_gps_datetime IS NULL`) is not inactive and has no
SLA bucket, so it falls into `healthy`. The Excel treats these as a distinct third state, **NDD**
(343 devices, of which 46 are mirrored into FSM). Measured in FSM: **51 operational Nuvista devices
have null GPS and are today counted inside `healthyOperational` (8,258)**; 62 Nuvista rows have null
GPS in total.

Small in count, wrong in kind: "we have never heard from this device" is being reported as
"this device is reporting normally." The scale is limited only because most NDD devices are
undeployed and therefore never mirrored.

### F4 — 9 Deployed, ONLINE devices missing from FSM · confidence **HIGH** (that they disagree)

Nine devices are `Deployed` + `ONLINE`/`Active` in the Excel but absent from FSM entirely.
I queried production: **all nine are `UNDEPLOYED` in `ap_masters.mst_vehicle`.**

| device_id | vehicle_no | plant | Excel |
|---|---|---|---|
| 867542081467592 | RJ27GC1671 | NIMBOL | Deployed · ONLINE |
| 867542081502265 | RJ01GC5671 | NIMBOL | Deployed · ONLINE |
| 867542081486428 | RJ57GA0102 | NIMBOL | Deployed · ONLINE |
| 867542081350921 | RJ01GC6673 | CHITTOR | Deployed · ONLINE |
| 867542081316898 | NL01AJ0565 | NIMBOL | Deployed · ONLINE |
| 867542081483599 | RJ57GA0249 | NIMBOL | Deployed · ONLINE |
| 862491072520602 | RJ33GA4914 | CHITTOR | Deployed · ONLINE |
| 867542081358619 | RJ27GE5199 | NIMBOL | Deployed · ONLINE |
| 867542081500061 | NL04AA4221 | RISDA | Inactive · EPF |

FSM's exclusion is *correct given `mst_vehicle`* — the insert-scope pin did its job. **This is an
Excel-vs-source disagreement at the raw-row level, not an FSM query bug.** Per the working rules I am
flagging it rather than papering over it: either the Excel reads deployment from a different column
(likely `ap_widgets.tb_vehiclemaster.vehicle_deployment_status`, which the 2026-07-17 investigation
measured as disagreeing with `mst_vehicle` ~1.3% of the time) or these nine flipped in the 50 minutes
between the two reads — implausible at 9 rows.

### F5 — The Excel is missing 1,156 vehicles vs the source · **UNRESOLVED** · confidence **MEDIUM**

For the same 22 NUVISTA plants, production `mst_vehicle` holds:

| | AutoPlant | Excel | Δ |
|---|---:|---:|---:|
| DEPLOYED | 7,709 | 7,650 | +59 |
| UNDEPLOYED | 18,661 | 17,564 | +1,097 |
| **Total** | **26,370** | **25,214** | **+1,156** |

Ruled out on the source side: `vehicle_type` (100% `DEDICATED`) and `vehicle_status` (100% `1` — the
soft-delete flag is not the filter). Leading hypothesis: the Excel is built from
`ap_widgets.tb_vehiclemaster` joined to the masters, so only vehicles with a widgets row (device
fitted / ever pinged) appear — consistent with the Excel carrying GPS, IMSI and `hw_version`
columns. **Not confirmed.** My 22-plant list is derived from FSM and may also not be exactly the
Excel's plant scope.

### F6 — 262 FSM devices absent from the Excel · confidence **HIGH** (measured), cause open

157 are `is_departed = true` / `UNDEPLOYED`; **105 are `is_departed = false` / `DEPLOYED`** — FSM
believes these are live Nuvista vehicles the source report does not list at all. 16 have no GPS.
Same root question as F5.

---

## 1b. ROOT CAUSE OF F1 — `import type` erasure kills the departure pass in DI

**Confirmed at code level, not inferred.**

`master-sync.service.ts` imports both of its optional collaborators as **types only**:

```ts
import type { DeviceDepartureService } from '../../device-departure/device-departure.service';   // :2
import type { PlantEligibleFloatingSeService } from '../../org/plant-eligible-floating-se.service'; // :3
```

A `import type` is erased at compile time, so TypeScript cannot emit the class in the constructor's
decorator metadata. The compiled `dist/ingestion/autoplant/master-sync.service.js:364` proves it —
note the last two entries:

```js
__metadata("design:paramtypes", [prisma_service_1.PrismaService,
    master_sync_run_service_1.MasterSyncRunService, Object, Object, Object, Object, Object, Object])
```

Parameters 3–6 are also `Object`, but each carries an explicit `@Inject(TOKEN)` so Nest resolves them
by token. Parameters **7 (`departures`) and 8 (`floatingEligibility`) have `@Optional()` and no
`@Inject()`** — Nest has nothing to resolve them by, and `@Optional()` converts that failure into a
silent `undefined` instead of a boot error.

The result is `master-sync.service.ts:397`:

```ts
if (!this.departures) return;   // always taken under Nest DI
```

The departure/restore pass **returns before doing anything**, leaving `stats.departures` at its
initialised `{skipped: 0, updated: 0, inserted: 0}` — exactly the signature on every run from 81
onward, with no `RECONCILE_FAILED` marker.

**Why runs 64 and 80 worked:** both were manual CLI runs. `autoplant-sync.ts:68` constructs the
service by hand (`new DeviceDepartureService(prisma)`) and bypasses DI entirely. The Nest-wired path
— the scheduler and the "Run Ingestion Now" API — has, on this evidence, **never** executed the
lifecycle pass.

**This is the same defect class as HEAD's most recent commit**, `f813b39 fix(#217):
OpsExplorerQueryDto import-type erasure broke every real query`. Same mechanism, different file.

**Second casualty, same line:** `PlantEligibleFloatingSeService` (#138 slice 2) is null for the same
reason, so the post-sync `plant_eligible_floating_se` MV refresh never runs under DI either. That MV
exists in the database. I have not measured its staleness — flagging it, not claiming it.

### Verification chain

1. All 795 Nuvista devices have an **open** `device_departures` row — `is_departed` faithfully
   mirrors the ledger, so the denormalisation is *not* the bug.
2. Every open departure was written by run **64** (2026-07-18) or run **80** (2026-07-21). Nothing
   since. The only restores ever performed are **253**, all by run 80.
3. Sampled 90 of the 795 against production `mst_vehicle`: **85 are `DEPLOYED` today**, 5 absent.
   They are in the read's `observed` map and satisfy the restore branch
   (`device-departure.service.ts:164`) on every run — so "ran and found nothing" is impossible.
4. `dist` metadata shows the dependency cannot be injected.

> Note a latent second bug in the same function: a departed device whose id is **absent** from the
> read can never be restored. Line 152 requires `observed.has(device_id)`, and the `else if` at
> :167 only opens departures (`active_departure_id === null`). The 5 absent devices in the sample sit
> in that hole permanently. Worth fixing alongside, but it is not the cause of F1.

### Blast radius (pan-India, all companies)

| | Devices |
|---|---:|
| Missed **restores** (departed in FSM, DEPLOYED at source) | **2,197** |
| Missed **departures** (operational in FSM, UNDEPLOYED at source) | **4,028** |
| **Total misclassified** | **6,225 of 26,446 — 23.5%** |

**The operational cost:** 2,871 tickets on those hidden-live devices were auto-cancelled when the
departures were opened, and **1,050 of the hidden-live devices are currently silent for >24 h and
cannot raise a ticket at all** — `is_departed = true` suppresses ticket creation. Those are real
field faults on live vehicles that FSM is structurally blind to.

### Proposed fix — **not applied, awaiting your approval**

One-line-per-dependency change in `master-sync.service.ts`; drop `type` from the two imports so the
class survives to runtime:

```ts
import { DeviceDepartureService } from '../../device-departure/device-departure.service';
import { PlantEligibleFloatingSeService } from '../../org/plant-eligible-floating-se.service';
```

Belt-and-braces alternative that also survives a future `import type` slip — make the token explicit:

```ts
@Optional() @Inject(DeviceDepartureService) private readonly departures: DeviceDepartureService | null = null,
```

After the fix, the next sync will open ~4,028 departures and perform ~2,197 restores in one pass.
**That is a large state change and should go through the existing `autoplant:departure-dryrun`
gate first** (the read-only tool built for exactly this in #128), with the counts reviewed before
applying — the same operator-approval posture #128 used for its backfill.

A regression guard is worth adding: assert `stats.departures` is non-zero, or that
`MasterSyncService` resolves a non-null `departures`, in a DI-booted (not hand-constructed) test.
Every existing test constructs the service manually, which is precisely why this passed CI.

---

## 2b. Corrected query result (F1) — a partial fix, measured

`corrected-queries.sql` **Q2** replaces the drifted `is_departed` denormalisation with the source
status allow-list. Run against the live mirror:

| | Devices | vs Excel |
|---|---:|---:|
| Excel ground truth (Deployed, shared devices) | 7,641 | — |
| FSM as shipped (`is_departed = false`) | 9,437 | **+1,796 (+23.5%)** |
| **Q2 corrected (`v.status IN ('DEPLOYED','ACTIVE')`)** | **7,794** | **+153 (+2.0%)** |

**This closes ~91% of the gap but does not fully reconcile, and I am not reporting it as complete.**
The residual +153 is accounted for: 105 of the 262 FSM-only devices are `DEPLOYED` and absent from
the Excel (F6), plus the 51 devices where the Excel says `Undeployed` and `vehicles.status` still says
`DEPLOYED` — sync lag on the last observation. Both are F5/F6 scope questions, not query defects.

Q2 is a **diagnostic**, not a proposed patch. Switching the dashboard to read `vehicles.status`
directly would bypass the `device_departures` ledger, which `docs` records as the binding lifecycle
truth for safety gates (the three-tier status authority pinned in the #130 ruling). The right fix is
to repair whatever has desynchronised `is_departed` from the ledger — not to route around it.

**Affected surfaces sharing this code path:** `FLEET_COUNT_COLUMNS` backs the KPI strip, the Zone
Performance Scorecard, company×plant overview, and the Fleet Directory (`dashboard.service.ts`), so
all four carry the same error. `is_departed` additionally gates ticket creation, SLA bucketing,
uptime eligibility and dispatch recommendation — the 795 hidden-live devices are invisible to all of
them.

---

## 3. Explained, not defects

- **459 devices** Inactive in the Excel but `is_inactive = false` in FSM → **455 are departed.**
  Documented behaviour: "a departed device is never counted inactive" (`kpi-definitions.md` §3).
  Only 4 unexplained. *Not a bug* — though note it interacts with F1: some of those 455 are departed
  *wrongly*.

---

## 4. What the Excel and FSM both get wrong

1. **`IMSI_NO` is unusable as a key** — 8 duplicated values, `899192250` repeated **23 times** and
   only 9 digits long (a real IMSI is 15). 1,618 blank. Neither side should join on it.
2. **`Reason Code` is incoherent** — 23,475 rows read `NO TRIP > 15 DAYS`, including **5,450 rows
   that are simultaneously Active with a CS Issue**; 520 rows contain the literal string `0`.
3. **Bucket labels are off by one** — `(03-07) Days` actually holds ages 2–7 days, `(08-15)` holds
   7–15. The partition is clean; the names misdescribe it.

---

## 5. Assumptions

1. Excel `Company Name = NUVISTA` ↔ FSM `company_id = 4` (`Nuvista`). `Nuvista Rakesiding` (id 37,
   81 devices) **excluded** — no Excel device matched it, so this is verified, not assumed.
2. Excel `GPS_DATE_TIME` is naive IST (UTC+5:30). Supported by `source-reader.ts`, which documents
   `latest_gps_datetime` as a naive DATETIME needing IST normalisation.
3. Excel snapshot instant = `max(GPS_DATE_TIME)` = 2026-08-07 06:49:21 IST, bracketed to
   06:49:10–06:50:47 by the 24 h bucket boundary.
4. Per your instruction, sub-hour drift between the two reads is treated as noise. The ~5.1 h GPS
   staleness in F2 is **not** drift — it is 5× larger and one-directional.
5. The 22-plant NUVISTA list used for the production queries was derived from FSM's `plants` table,
   not from an AutoPlant company key. This is the weakest assumption in the report and bears
   directly on F5/F6.

## 6. Open questions

1. **F1 mechanism** — may I read `device_departures` for the 755 DEPLOYED-but-departed devices to
   confirm whether auto-restore is failing to close them? (Local Postgres, read-only.)
2. **F5/F6 scope** — is there an authoritative NUVISTA company/plant key in AutoPlant, or is the
   Excel's plant list the definition of scope?
3. **Which column does the Excel's `Deployment Status` come from** — `mst_vehicle` or
   `tb_vehiclemaster`? Resolving this settles F4 outright.
4. **F2** — is the 5.1 h staleness expected in this environment (scheduler off / manual runs), or is
   run 151's short duration a real ingestion failure?
