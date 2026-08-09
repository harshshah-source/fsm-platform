# 223 — Devices that have never reported are counted as "healthy"

Status: needs-triage — **P1 decided by operator 2026-08-07** (never-reported = fault). Design below;
P2–P7 still unresolved. **Ship as one slice with [#222](./222-telemetry-staleness.md).**
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

## The second question — operationally inactive, reported separately (RECOMMENDATION)

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

**Operator decides. This is a recommendation, not a decision taken.**

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

**Grace window (P2, unresolved):** the `hours >= threshold` comparison gives a *de facto* grace window
of `inactivity_threshold_hours` (24 h) for free. If 24 h is the right answer, **no new setting is
needed** — 153 of 907 are ≤2 days old and a meaningful share of those are legitimately commissioning.
If the operator wants a longer install grace (say 72 h), it needs its own setting rather than
overloading `inactivity_threshold_hours`, which is the Fleet-Uptime denominator and must not be
tuned for this.

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

1. **Mirror `installed_at`** — add the column to `devices`, read `FIRST_INSTALLED_DATE_TIME` in
   `autoplant-source-reader.ts` / `master-mapping.ts`, backfill on the next master sync.
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

- **Q1.** Is `FIRST_INSTALLED_DATE_TIME` UTC? Not separately verified; matters only if P2 sets a
  grace window shorter than ~12 h.
- **Q2.** Should the >1-year cohort (602) be ticketed at all, or reported-only until the install-vs-
  field routing question is settled? Interacts with P1's intent.
- **Q3.** Do the 6 devices with no `installed_at` anywhere need a fallback (`devices.created_at`,
  first appearance in `master_sync_runs`)? They are currently 6 rows; the fallback may not be worth it.

## Remaining product decisions — UNRESOLVED, not guessed at

Carried from `audit/cross-analysis.md` §5. **None of these has been assumed in the design above.**

| # | Decision | Blocks |
|---|---|---|
| **P2** | Grace window from fitment before a never-reported device becomes a fault. 24 h falls out for free; anything else needs its own setting. | The `hours` branch |
| **P3** | Does a never-reported device count as **0% uptime** or is it **excluded** from Fleet Uptime? Contractual/commercial, not technical. Today all 913 are `eligible_for_uptime` and have no failure cycle, so they score **100% uptime** — the most broken device in the fleet scored as the healthiest. | Uptime aggregation |
| **P4** | Fourth dashboard tile, or fold into a widened "not reporting" figure? (See recommendation above — separate.) | Admin UI |
| **P5** | Vasavadatta (545) and Deepak Fertilizer (208) see visible health drops. Customer communication first? | Release sequencing |
| **P6** | Handling for the ~5 IST-writing devices. Owned by [#222](./222-telemetry-staleness.md). | #222 |
| **P7** | Ship order — **DECIDED**: #222 + #223 as one slice. | — |

## Acceptance

- `devices.installed_at` mirrored from `FIRST_INSTALLED_DATE_TIME`; coverage ≥ 99% of operational devices.
- `never_reported` derived; `healthyOperational` excludes null-GPS devices.
- `healthy + inactive + neverReported = operational` holds at fleet, zone, company and plant level,
  and `reconciliation.service.ts` asserts the **new** identity.
- `kpi-definitions.md` updated in place (not a new doc — CLAUDE.md convention).
- Fleet Health % reads **84.84%** fleet-wide with #222 landed.
- The 892 confirmed-NDD devices are ticketed, or explicitly held per Q2 with the hold recorded.
- Fleet Composition funnel sums with the third branch.
- P2–P5 answered and recorded here before the slice is marked done.
