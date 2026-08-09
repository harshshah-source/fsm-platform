# 223 — Devices that have never reported are counted as "healthy"

Status: **done (code) 2026-08-09, with two data-gated acceptance criteria explicitly outstanding** —
see Acceptance. The state model, the identity and all six read surfaces are landed and green; the
fleet-wide numbers and `installed_at` coverage need the operator-gated master sync.
**Q2 (ticket the 602 >1-year cohort, or hold?) is still unanswered and should be settled before the
first ticketing sweep.**
**P1 decided by operator 2026-08-07** (never-reported = fault);
**P2–P7 decided by operator 2026-08-09** (recorded in "Remaining product decisions" below, which is no
longer a list of unknowns). **Q2 is the one product question still open.**
**Ship as one slice with [#222](./222-telemetry-staleness.md).**
Type: HITL (changes a published KPI definition; opens ~912 tickets) · Backend + Admin
Filed: 2026-08-07
Origin: AutoPlant↔FSM reconciliation finding **F3**
(`audit/autoplant-reconciliation/reconciliation-report.md`), independently re-found by the blind
PRISM read (`audit/prism-independent/`), reconciled and extended in `audit/cross-analysis.md`.
Deliberately excluded from [#218](./218-lifecycle-drift-detection.md) by operator decision.
Coordinates with: [#222](./222-telemetry-staleness.md) (opposite-direction Fleet Health movement —
must ship together) · [#217](./217-ops-explorer.md) (owns `ReconciliationIdentity`) ·
[#228](./228-guard-pattern-remediation.md) (the tautological identity that hid this) ·
[#112](./112-ticket-activation-eligibility-mode.md) (`eligibility_mode`)

## Problem

`healthyOperational` is defined as the *negation* of inactive (`dashboard.service.ts:43`,
`FLEET_COUNT_COLUMNS`):

```sql
COUNT(*) FILTER (WHERE ds.is_departed = false
                   AND NOT (ds.is_inactive = true AND ds.sla_bucket IS NOT NULL))
```

A device that has never reported GPS (`latest_gps_datetime IS NULL`) is not inactive and has no SLA
bucket, so it falls into `healthy` by construction. **Absence of evidence is read as evidence of
health.**

### Measured, fleet-wide, re-verified 2026-08-07

| | Devices |
|---|---:|
| Operational (`is_departed = false`) | 15,696 |
| Counted `healthyOperational` | 13,021 |
| **Null-GPS, non-departed — counted healthy** | **913** |
| …of those, `eligible_for_uptime = true` | **913 (all)** |
| …of those, already holding a failure cycle | **0** |

Concentrated, not diffuse — for the top two companies the health figure is materially fiction:

| Company | NDD counted healthy |
|---|---:|
| Vasavadatta | **545** |
| Deepak Fertilizer | **208** |
| Nuvista | 38 |
| Prism Cement | 25 |
| HCCB / SAURASHTRA / Testing Co / UTCL / Vicat / Zuari | 65 |
| *(remainder)* | 32 |

### Verified independently at the source

The 913 device ids were taken to AutoPlant production directly, without reference to what FSM
believes:

| Question asked of `ap_widgets.tb_vehiclemaster` | Answer |
|---|---:|
| Rows found | 907 (6 absent from source → [#227](./227-orphaned-mirror-rows.md)) |
| `latest_gps_datetime IS NULL` — genuinely never reported | **892** |
| `latest_gps_datetime IS NOT NULL` — **has** reported | **15** → [#226](./226-null-gps-over-real-telemetry.md) |
| `vehicle_deployment_status = DEPLOYED` | 676 |
| `= UNDEPLOYED` | **0** |

**892 are unambiguous.** Deployed or active vehicles, device fitted, and the source has never
received a single GPS fix. Not undeployed, not warehoused, not stale.

## Why it happens — the reasoning, not the SQL

The NULL case **was** considered, at the state layer. `device-state.service.ts:108`:

```sql
is_inactive = (NOT dr.departed AND dr.hours IS NOT NULL AND dr.hours >= ${threshold}),
```

`dr.hours IS NOT NULL` is a deliberate guard: whoever wrote it knew a device could have no GPS and
decided such a device must not be called *inactive*. Correct locally — "never heard from it" is not
"it went silent". **The failure is that the guard was never followed through to the consumers**: the
device, having been excluded from `inactive`, was swept into `healthy` by the negation.

**And the binary was then hardened on purpose.** `docs/kpi-definitions.md` §"Healthy Operational
Devices", in the author's own words:

> **Reconciles** `healthy + inactive = operational`, exactly, at every level.
>
> *"Counted directly rather than subtracted, over the complement predicate on the same non-departed
> set — so the identity holds by construction rather than by arithmetic that could be applied
> inconsistently."*

**That paragraph is where the third state became unrepresentable.** The two-state identity was not an
accident — it was engineered as a guarantee, and the engineering that guarantees it is exactly what
forecloses NDD. The same document defines healthy in prose as *"operational devices **reporting
normally**"*. The prose says "reporting normally"; the SQL says "not inactive"; nothing compares them.

`docs/kpi-definitions.md` contains **zero** occurrences of `NDD`, "never reported", or any null-GPS
discussion. The concept appears in no issue in this backlog. **The state was simply never modelled.**

## P1 — DECIDED (operator, 2026-08-07)

> **A tracker that is fitted and has never reported is a fault, not a pipeline state.** It should be
> counted as inactive and raise alerts like any other silent device. A vehicle running untracked
> since the day it was fitted is exactly the thing this platform exists to catch.

Recorded as a **business decision**, not an engineering inference. Rationale as given: the platform
exists to catch untracked vehicles; a never-reported tracker is the most complete instance of that.

## The starting-point problem — RESOLVED, a usable date exists

A normal device becomes inactive 24 h after its last report. A never-reported device has no last
report. Investigated before designing:

**`ap_widgets.tb_vehiclemaster.FIRST_INSTALLED_DATE_TIME` is the answer.** Coverage on the 907:

| Candidate column | Non-null on the 907 |
|---|---:|
| **`FIRST_INSTALLED_DATE_TIME`** | **907 / 907 (100%)** |
| `LATEST_INSTALLATION_DATE_TIME` | 890 |
| `insertion_datetime` | 287 |
| `DEVICE_LATEST_INSTALLATION_DATE` | 149 |
| `device_installation_date` | 136 |
| `RECORD_CREATED_DATE` | 130 |
| `VEHICLE_MAPPING_DATE` | 125 |
| `SIGNAL_RECEIVED_TIME` | 15 |
| `CREATED_DT` | 0 |

**Validated, not assumed.** On 21,244 devices that pinged within the last 24 h:
`FIRST_INSTALLED_DATE_TIME <= latest_gps_datetime` on **21,238**, **0 bogus** (installed after first
ping), 6 with no date. **99.97% clean.** No future values and no pre-2000 values on the NDD set.

### Age since installation, the 907

| Bucket | Devices |
|---|---:|
| ≤ 2 days | 153 |
| 3–7 days | 45 |
| 8–30 days | 16 |
| 31–90 days | 32 |
| 91–365 days | 59 |
| **> 1 year** | **602 (66%)** |

**602 devices were fitted over a year ago and have never reported once.** These are not
commissioning. `mst_vehicle` carries the same columns (`first_installed_dt`) as a cross-check.

**FSM ingests no installation date today** — a repo-wide grep finds no reference to any of these
columns. Adding one is required work, not optional.

## The second question — operationally inactive, reported separately (ACCEPTED — P4, 2026-08-09)

Operator asked whether NDD devices should be **merged** into inactive or **operationally inactive but
reported separately**. Recommendation: **reported separately.** Reasoning:

1. **They have different root causes and different owners.** "Never worked" is an installation-quality
   failure — the installer, the vendor, the commissioning process. "Stopped working" is a device
   failure — the field SE. Merging them hides which of the two is degrading.
2. **They would swamp the band they land in.** 602 devices are >1 year old, so on any age-based
   bucketing they all land in `LONG_PENDING` (7 d+, the open-ended top band). That band currently
   holds **1,456** devices — adding 602 is **+41%**, and the genuine 7-day backlog becomes
   unreadable.
3. **The business already reads three states.** The ground-truth Excel reports NDD as a peer of
   Active and Inactive; its totals only close as `active + inactive + NDD`.
4. **Asymmetric reversibility.** Reported separately and unwanted → drop a tile. Merged and later
   wanted → the distinction has to be re-derived from scratch.

**This costs almost nothing to do properly:** one derived boolean alongside `is_inactive`. The
operational treatment (ticket, dispatch, SLA) is identical either way — only the reporting splits.

**ACCEPTED by the operator 2026-08-09 as P4.** Stated reasoning: *"Different root causes, different
owners; 602 year-old devices would make the genuine backlog unreadable."* Never-reported therefore gets
its **own dashboard figure**, sitting beside Fleet Health rather than folded into it.

## Design

### State model

`is_inactive` stays the operational gate — it is what ticket creation, dispatch and SLA all read, and
under P1 a never-reported device must satisfy it. A new **orthogonal** flag carries the reporting
distinction:

| Column | Meaning |
|---|---|
| `device_states.never_reported` (bool, derived) | `latest_gps_datetime IS NULL` and the device has been installed longer than the grace window |
| `device_states.inactivity_hours` | for NDD, measured from `installed_at` instead of last ping |
| `devices.installed_at` (timestamptz, **new**, mirrored) | `FIRST_INSTALLED_DATE_TIME`, normalised |

`is_inactive` becomes:

```sql
is_inactive = (NOT departed AND hours IS NOT NULL AND hours >= threshold)
-- where `hours` is now:
hours = CASE WHEN latest_gps_datetime IS NOT NULL
               THEN now - latest_gps_datetime
             WHEN installed_at IS NOT NULL
               THEN now - installed_at        -- ← the new branch
             ELSE NULL END                    -- ← no date anywhere: still unrepresentable, stays out
```

**Why measure from install rather than adding a new SLA band:** it is semantically honest ("this
device has been broken for 602 days"), it makes the existing `SLA_BANDS` work unchanged, and it needs
no enum migration. `SLA_BANDS`' top entry `[168, 'LONG_PENDING']` is open-ended, so every long-NDD
device buckets correctly without new code. The reporting split is then carried by `never_reported`,
not by a bucket.

**Grace window — P2 DECIDED (operator, 2026-08-09): 24 h, reusing `inactivity_threshold_hours`. No new
setting.** The `hours >= threshold` comparison gives that window for free, so the branch above is the
whole implementation. Operator's stated reasoning: it covers ~86–97% of the measured curve. The
decision was taken with an explicit invitation to push back — *"if your implementation makes 48
materially better for a reason I have not seen, say so before building rather than after."*

**Push-back considered and declined, 2026-08-09 — 24 h stands.** No evidence was found that 48 h is
materially better:

- **The population is not commissioning.** 602 of 907 (66%) were fitted over a year ago; only 153 are
  ≤2 days old. Interpolating uniformly inside that bucket, 24 h ticket ≈831 devices and 48 h ≈754 — the
  two windows differ by roughly **77 devices out of 907**, all of them in the band where the answer is
  genuinely ambiguous.
- **A false positive self-corrects and is cheap.** A device still commissioning that gets ticketed at
  24 h closes itself the moment it pings: `AutoRecoveryService`'s ≥3-pings-≥15-min rule is satisfied by
  a device coming alive, with no SE effort credited. A missed install failure does not self-correct.
- **One threshold is easier to reason about than two.** At 24 h "inactive" means the same thing for
  every device on the dashboard. A second, install-only window means every NDD figure has to be read
  against a different clock from the one beside it.

The measurement that *would* settle this properly — the install→first-ping delay distribution for
devices that did eventually report — needs AutoPlant source access and has not been run.
`device_states.first_reported_at` (landed `5a486f8`) is the FSM half of it; the install half arrives
with the first master sync that writes `device_commissioning`. **If the operator wants 48 h revisited,
that is the query to run**; it is not a reason to hold this slice.

### The ticket-creation path is NOT a blocker — correction to `audit/cross-analysis.md`

The cross-analysis stated that failure cycles are transition-driven and *"the current failure-cycle
machinery is entirely transition-driven and cannot represent 'was never good'"*. **That is wrong, and
it removes the piece of work the operator expected to be hardest.**

`ticket-creation.service.ts:34-52` is a **state scan**, not a transition detector:

```ts
const candidates = await this.prisma.deviceState.findMany({
  where: { isInactive: true, eligibleForUptime: true, hasOpenFailureCycle: false, … },
});
```

There is no "was reporting, now silent" check anywhere. `hasOpenFailureCycle: false` plus the I1
partial-unique is the dedup mechanism. **The moment `is_inactive` becomes true for an NDD device, a
failure cycle and a TROUBLESHOOT ticket are created by the existing code with no changes at all.**

`AutoRecoveryService` also needs no change: it looks for ≥3 pings ≥15 min after `cycle.openedAt` in
`raw_device_snapshots` (`auto-recovery.service.ts:41-47`). An NDD device that finally comes alive
satisfies that criterion exactly and auto-closes.

**Re-measured 2026-08-09 (operator's pre-application gate — see
[#222](./222-telemetry-staleness.md) "Expected auto-recovery closure count" for the sweep side).**
All 913 null-GPS operational devices are `eligible_for_uptime`, **none** holds an open failure cycle,
and all 913 carry a `plant_id` + `company_id` — so the ticketable count off `device_states` alone is
**913**, of which 912 survive the deactivated-plant exclusion. Unchanged from 2026-08-07.

**These tickets will not auto-close.** An NDD device has no pings at all, so it can never satisfy
`AutoRecoveryService`'s ≥3-pings-≥15-min rule — and the sweep is unwired regardless
([#229](./229-auto-recovery-sweep-unwired.md)). Every one of the ~912 is a permanent addition to the
open queue until an SE or an installer closes it. That is the opposite risk profile from #222's
falsely-inactive 434, and it is why Q2 (below) matters.

**Every ticketing precondition is already met by all 913:**

| Precondition | Satisfied |
|---|---:|
| `plant_id IS NOT NULL` | 913 |
| `company_id IS NOT NULL` | 913 |
| `eligible_for_uptime = true` | 913 |
| `has_open_failure_cycle = false` | 913 |
| Not on a deactivated plant | 912 (1 excluded, correctly) |
| **Would create a ticket on the next sweep** | **912** |

### Minimum viable change

1. **Mirror `installed_at`** — ~~add the column to `devices`, read `FIRST_INSTALLED_DATE_TIME` in
   `autoplant-source-reader.ts` / `master-mapping.ts`~~ **PARTLY DONE in `5a486f8`, and by a better
   route than this step proposed.** The source read exists and is normalised at offset 0
   (`master-mapping.ts` `parseInstalledAt` / `mapCommissioning`, fed from the `ap_widgets` join in
   `autoplant-master-source.ts`), and it lands in the **append-only `device_commissioning` table**
   rather than a mutable column on `devices` — because `tb_vehiclemaster` rewrites fitment in place
   (10,565 devices have had `first_installed_dt` moved, 1,757 by more than a year), so a mirrored
   column would silently lose the original commissioning date on every re-map.
   **Do not re-implement the read.** What remains is the *derivation* side: `DeviceStateService.recompute`
   needs an install instant per device to feed the new `hours` branch, read from `device_commissioning`
   (or a `devices.installed_at` maintained *from* it — the state layer must not re-parse the source).
   **Which row wins is a design decision this slice must take and record:** `MIN(installed_at)` is
   "broken since first fitment" (right for a device that has never reported at all under any fitment);
   `MAX(installed_at)` treats a re-fitment as a fresh commissioning clock. The NDD definition — never
   reported *ever* — argues for `MIN`.
   **Blocker on the data, not the code:** `device_commissioning` is **empty** in the dev DB (0 rows,
   measured 2026-08-09) because no master sync has run since the migration landed, and a master sync
   now executes #218b's live lifecycle pass — which is exactly the run #218c holds under an operator
   gate. So the acceptance criterion "coverage ≥ 99% of operational devices" is **not verifiable
   locally today**; it is verifiable on the first gated master sync.
2. **Extend the `hours` derivation** in `DeviceStateService.recompute` with the `installed_at` branch.
3. **Add `never_reported`** as a derived boolean in the same UPDATE.
4. **Add `neverReported` to `FLEET_COUNT_COLUMNS`** and narrow `healthyOperational` with
   `AND ds.latest_gps_datetime IS NOT NULL`.
5. **Update the identity** to `healthy + inactive + neverReported = operational` in
   `reconciliation.service.ts:205`, `kpi-definitions.md`, `dashboard.service.ts:25,59-60,72-74`,
   `apps/admin/src/lib/kpiCatalog.ts:137`, and the Fleet Composition funnel
   (`dashboard.service.ts:175-198,436-470`).
6. **Admin surfaces** — a fourth tile/column on the KPI strip, Zone/Company-Plant tables, and a
   Fleet Directory filter value.

Cost: **one slice, no data migration beyond the mirrored column.** Ticketing, dispatch, SLA, auto-
recovery and uptime all follow for free because they read `is_inactive`.

### The correct model (beyond MVP)

The MVP still cannot distinguish **commissioning** from **dead-on-arrival** except by the grace
window. A fuller model replaces the boolean pair with an explicit
`device_report_state` enum — `REPORTING | SILENT | COMMISSIONING | NEVER_REPORTED` — with
`is_inactive` retained as a derived compatibility view so nothing downstream breaks on day one, plus
a distinct `work_type` or ticket sub-class so install failures route to the installer/vendor rather
than to a field SE.

Cost: enum + migration, a second ticket route, and rework of every export and Ops Explorer dataset
that reads the booleans. **1–2 weeks.** Do not attempt it in this slice.

## What breaks

| # | Thing | Detail |
|---|---|---|
| 1 | **`reconciliation.service.ts:205`** | Asserts `healthyOperational + inactiveOperational = operationalDevices`. **Fails until updated.** Must ship in the same change. |
| 2 | **`dashboard-kpi-reconciliation.e2e-spec.ts`** | Asserts the identity plus hardcoded fixture counts (`:143-144`, `:177-178`). The Σ-identities survive a three-way split; the fixture counts need review. |
| 3 | **`dashboard-total-devices.e2e-spec.ts`** | Same family. |
| 4 | **`docs/kpi-definitions.md`** | States `Inactive % + Fleet Health % = 100%` as a guarantee. Becomes false. Authoritative per CLAUDE.md — edit in place. |
| 5 | **Fleet Composition funnel** | Renders `operational → healthy + inactive` as a two-way split; needs a third branch or it will not sum. |
| 6 | **Ops Explorer `plants` dataset** | `healthyDeviceCount` uses `is_inactive = false` while claiming *"Same predicate as FLEET_COUNT_COLUMNS.healthyOperational"* (`dataset-registry.ts:1072`). Only equivalent because `is_inactive` implies a non-null bucket. Both need the new predicate. |
| 7 | **Admin components** | `OperationalFleetSection`, `ZoneOverviewTable`, `CompanyPlantTable`, `ScorecardTable`, `FleetDirectoryPage`, `ZoneDrilldownSection` all consume the two-way split. |
| 8 | **`soft_inactive_count_history`** | Holds denominators snapshotted under the old definition. Trend charts step-change on the fix day — correct, but expect it. |
| 9 | **~912 new TROUBLESHOOT tickets in one sweep** | Against a baseline of **12,571 open** — a **+7.3%** step. Needs a controlled rollout (see Risks). |

**Not affected:** SLA bucketing logic (bands unchanged), dispatch/recommender (consume tickets),
auto-recovery, the departure invariant.

### Fleet Health movement (measured)

| Scenario | Fleet Health % | Operational | Healthy |
|---|---:|---:|---:|
| As shipped today | **82.96%** | 15,696 | 13,021 |
| #223 alone (NDD out of healthy and denominator) | **81.90%** | 14,783 | 12,108 |
| #222 alone (timestamp fix) | **85.72%** | 15,696 | 13,455 |
| **Both — the correct figure** | **84.84%** | 14,783 | 12,542 |

**The two defects have been partly cancelling.** NDD inflates by ~1.06 points, the timestamp shift
deflates by ~2.76. Net error today ≈ −1.9 points; gross error ≈ 3.9 and unstable. **This is why the
two must ship together** — #223 alone moves the number *down* and reads as a regression caused by a
bug fix. Operator confirmed this sequencing 2026-08-07.

## Risks

- **Ticket volume step.** ~912 tickets at once, 602 of them for devices broken >1 year. They will be
  dispatched to SEs who cannot fix an installation defect. **Mitigation:** stage the backfill behind
  an operator gate (the `autoplant:departure-dryrun` posture #128/#218 used), and consider holding
  the >1-year cohort until P1's routing question (install vs field) is settled.
- **`installed_at` for devices absent from source.** The 6 orphans have no source row; they stay
  `NULL` and therefore stay out of the new branch. Acceptable and explicit.
- **Timezone of `FIRST_INSTALLED_DATE_TIME`.** Assumed UTC, consistent with the rest of
  `tb_vehiclemaster` post-#222. **Unverified.** At a 24 h grace window a ±5.5 h error is immaterial,
  but it must not be assumed for a shorter window. Open question below.

## Open questions

- **Q1. ANSWERED 2026-08-09 — yes, UTC (offset 0). CLOSED.** Measured, not inferred: compared against
  `device_installation_date` (a MySQL `TIMESTAMP` in the *same row*, so already-UTC on read) across
  **17,985 devices at exactly 0 minutes' difference, zero at ±330**, with no step across 2025→2026.
  The "naive `DATETIME` ⇒ IST" house rule that produced #222's `+330` is therefore wrong as a rule, not
  just for `latest_gps_datetime` — two unrelated columns, two independent methods, same answer.
  Encoded in `parseInstalledAt` (`master-mapping.ts`, `5a486f8`) as `TRUE_SOURCE_UTC_OFFSET_MIN`.
- **Q2.** Should the >1-year cohort (602) be ticketed at all, or reported-only until the install-vs-
  field routing question is settled? Interacts with P1's intent.
- **Q3.** Do the 6 devices with no `installed_at` anywhere need a fallback (`devices.created_at`,
  first appearance in `master_sync_runs`)? They are currently 6 rows; the fallback may not be worth it.

## Product decisions — P1–P7 ALL DECIDED

Carried from `audit/cross-analysis.md` §5. P1 decided 2026-08-07; **P2–P7 decided by the operator
2026-08-09**, reasoning as stated by them. None was inferred by an agent.

| # | Decision | Operator's stated reasoning |
|---|---|---|
| **P1** | **DECIDED 2026-08-07 — a fitted tracker that has never reported is a fault, not a pipeline state.** Counted as inactive; raises alerts like any other silent device. | *"A vehicle running untracked since the day it was fitted is exactly the thing this platform exists to catch."* |
| **P2** | **DECIDED — grace window = 24 h, reusing `inactivity_threshold_hours`. No new setting.** | Covers ~86–97% of the measured curve. Push-back invited and considered; **declined** — see the Design section for the evidence. |
| **P3** | **DECIDED — never-reported devices are EXCLUDED from Fleet Uptime, NOT scored 0%.** The never-reported count sits **beside** the KPI, not inside it. | *Scoring them zero is defensible, but excluding keeps the KPI measuring what it claims: reliability of devices that have reported.* Operator explicitly invited push-back on this one. |
| **P4** | **DECIDED — never-reported gets its own dashboard figure** (the "reported separately" recommendation above is ACCEPTED). | *"Different root causes, different owners; 602 year-old devices would make the genuine backlog unreadable."* |
| **P5** | **DECIDED — customer communication: NOT YET. Build it; the operator decides comms before anything is exposed.** | Vasavadatta (545) and Deepak Fertilizer (208) will see visible drops. |
| **P6** | **DECIDED — the two-directional skew guard ships in THIS slice**, not as a follow-up. Owned by [#222](./222-telemetry-staleness.md). | The current 24 h guard rejects only the future, so the ~5 IST-writing devices pass it and read as **permanently fresh** — worse than being dropped. *"That is the fourth #228 specimen and it is the only one still latent, so fix it before it activates."* |
| **P7** | **DECIDED 2026-08-07 — #222 + #223 ship together as one slice.** | #223 alone moves Fleet Health **down** 1.1 points with none of the offsetting +2.8 — a bug fix that reads as a regression. |

**Consequence of P3 on the implementation.** Exclusion is not the same edit as the tile. `eligible_for_uptime`
is the Fleet-Uptime denominator *and* the ticket-creation gate (`ticket-creation.service.ts:34-52`
requires `eligibleForUptime: true`), so clearing it for NDD devices would silently cancel P1 — the 892
confirmed-NDD devices would never be ticketed. **The exclusion must therefore happen in the uptime
aggregation, not by flipping `eligible_for_uptime`** (`fleet-uptime-aggregation.service.ts:52`). This is
the one place where two decided items pull in opposite directions through a shared flag; it is called
out here so the implementation does not discover it by breaking P1.

## Acceptance

- ⏳ `installed_at` mirrored from `FIRST_INSTALLED_DATE_TIME`; coverage ≥ 99% of operational devices.
  **Code landed, data absent.** The read and the append-only `device_commissioning` writer exist
  (`5a486f8`) and `DeviceStateService.recompute` now consumes `MIN(installed_at)`, but the table holds
  **0 rows** in the dev DB because no master sync has run since its migration — and a master sync now
  executes #218b's live lifecycle pass, i.e. the run #218c holds under an operator gate. Verifiable on
  the first gated sync, not before. **Not claimed as met.**
- ✅ `never_reported` derived; `healthyOperational` excludes null-GPS devices. Derived at read time
  rather than stored as a column — a deliberate deviation from the Design section above, because
  `latest_gps_datetime` is maintained at **ingest** while a stored flag would be written by the
  **recompute**, leaving the flag wrong for up to one interval on exactly the transition that matters.
- ✅ `healthy + inactive + neverReported = operational` holds at fleet, zone, company and plant level,
  and `reconciliation.service.ts` asserts the **new** identity — which, unlike the old one, can fail:
  `neverReported` is measured independently instead of as anyone's complement.
- ✅ `kpi-definitions.md` updated in place, including a correction of the "identity holds by
  construction" paragraph that made the third state unrepresentable.
- ⏳ Fleet Health % reads **84.84%** fleet-wide with #222 landed. Same gate as the coverage criterion:
  it needs a post-fix ingest + recompute against the real source. The arithmetic is pinned by the e2e
  identities; the fleet-wide number is not yet observed.
- ⏳ The 892 confirmed-NDD devices are ticketed, or explicitly held per Q2 with the hold recorded.
  **Q2 is still unanswered** (the operator did not answer it on 2026-08-09) and the ticket-creation
  path needs no code change, so this will happen on the first sweep after `installed_at` is populated.
  **This is the item to decide before that sweep runs**, and it is the same shape of gate the operator
  set on #222's closure count.
- ✅ Fleet Composition funnel sums with the third branch.
- ✅ P2–P5 answered and recorded here before the slice is marked done (see "Product decisions").
