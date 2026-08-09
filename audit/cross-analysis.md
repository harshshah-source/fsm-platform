# Cross-Analysis — reconciling the two independent reads

**Date:** 2026-08-07 · **Author:** the PRISM (independent) analysis, after lifting the blind and
reading `audit/autoplant-reconciliation/`, issue #218, and `.scratch/` in full.
**Posture:** read-only throughout. No source changed, no sync run, no data written. Every number
below was measured today, by me, against `localhost:5433` (FSM) and `10.0.0.25` (AutoPlant, `SELECT`
only).

---

## 0. Summary of what changed as a result of this cross-read

| Claim | Who said it | Verdict now |
|---|---|---|
| NDD counted as healthy | both reads, independently | **Confirmed** — and worse than either said (see §2) |
| FSM shifts GPS 5.5h into the past | PRISM | **Confirmed**, by stronger evidence than PRISM used |
| "Not a timezone bug, FSM data is stale" | NUVISTA / yesterday | **Wrong** — refuted, with yesterday's own numbers explained |
| "AutoPlant changed IST→UTC between 07-17 and 08-07" | PRISM (mine) | **Wrong** — the source never changed; the offset was wrong from day one |
| Three defects share a root cause | open question | **Yes** — a real, nameable pattern (§4) |

Two of the three headline conclusions I shipped yesterday in the PRISM report were right about the
*defect* and wrong about the *cause*. The correction matters, because "the source changed" implies a
one-line constant flip plus a vendor conversation, and "we mis-specified it at the start and pinned
it with a test" implies something quite different about the test suite.

---

## 1. First question — what were we both reading?

**Settled: the same database, and it is a local development instance.**

There is exactly one `DATABASE_URL` in the repo (`apps/backend/.env`):
`postgresql://fsm:test123@localhost:5433/fsm`. No second env file, no docker-compose, no
production FSM host is configured anywhere in the tree. The NUVISTA report's "local Postgres mirror"
and my "`localhost:5433`" are the same server. Measured identity:

| Probe | Value |
|---|---|
| `current_database()` / user | `fsm` / `fsm` |
| `inet_server_addr()` | `::1/128` — loopback, not a remote host |
| Version | PostgreSQL 16.14, compiled by **Visual C++** — a Windows local build |
| Database size | 680 MB |
| `pg_postmaster_start_time()` | 2026-08-06 12:04 IST |
| `users` email domains | `mock.fsm` (80), `fsm.test` (8) — **100% seeded** |
| `device_states` | 26,543 rows · 1,971 null-GPS · 10,847 departed |

**What it is:** a local dev FSM instance whose *organisational* data (users, SEs, zones, tickets) is
seeded and synthetic, but whose *device* data is a genuine mirror of AutoPlant **production**
(`10.0.0.25`), pulled by real master-sync and snapshot runs. So it is neither "production FSM" nor a
toy — it is a hybrid.

**Does it matter for the figures either analysis reported?** Split it:

- **Device-side figures — trustworthy.** Counts of devices, GPS timestamps, `is_inactive`,
  `is_departed`, NDD, the 5.5h offset: all derive from the production mirror and from FSM's real
  production code paths. `device_states` totals (26,543 / 15,696 operational) match what both reports
  used. These figures stand.
- **Anything downstream of seeded org data — do not trust.** Ticket counts, SE assignment,
  dispatch outcomes, zone rollups, the "2,871 auto-cancelled tickets" figure in the NUVISTA report.
  Those sit on 80 mock users and seeded zones. They are *shape-realistic*, not production-real.
- **One caveat on both reports' pan-India blast radii.** They are computed over the mirror, which is
  the real device population — so they are good estimates of production scale. But they were never
  confirmed against a production FSM deployment, because this repo has no connection to one.

**Plain statement:** neither analysis was reading a fake database, and neither was reading production
FSM. Every device-level defect claim in both reports survives this. Every operational-consequence
claim (tickets raised, tickets cancelled, SEs dispatched) is an inference from seeded data and should
be re-measured wherever production FSM actually runs. My PRISM report flagged this as its biggest
caveat; the caveat is real but narrower than I stated — it bounds the *consequences*, not the
*defects*.

---

## 2. The NDD / healthy defect

### 2.1 Confirmed, and independently verified at the source

Both reads found it with no shared context. I have now also verified it the way you asked — going to
AutoPlant directly and asking *it* what these devices are, without reference to what FSM believes.

**FSM's claim.** 913 devices are `latest_gps_datetime IS NULL`, `is_departed = false`. All 913 land
inside `healthyOperational`. All 913 also carry `eligible_for_uptime = true`. Zero are flagged
inactive.

**AutoPlant's independent verdict on those exact 913 device IDs:**

| Question asked of `tb_vehiclemaster` | Answer |
|---|---:|
| Rows found for those IDs | **907** (6 not in the source at all) |
| `latest_gps_datetime IS NULL` — genuinely never reported | **892** |
| `latest_gps_datetime IS NOT NULL` — **has** reported | **15** |
| …of which pinged within the last 24 h | **14** |
| `vehicle_deployment_status = DEPLOYED` | 676 |
| `= UNDEPLOYED` | **0** |
| Carries a `gpssignal` telemetry blob | 15 |

Sample (all `DEPLOYED`/`ACTIVE`, all null GPS at source):

| device_id | vehicle_no | plant | deployment |
|---|---|---|---|
| 860141073828460 | AP26TT6449 | Bharathi Cement Corpn P Ltd | DEPLOYED |
| 0359688090183707 | AP29U6808 | HCCBPL-VIZAG GREEN FIELD DEPOT | ACTIVE |
| 9573089085 | AP5TT5980 | TIMMAPUR RH 2371 | ACTIVE |
| 862491072757840 | BR24GD3593 | SATNA PLANT LINE 2 | ACTIVE |

**So the answer to "are they really NDD?" is: 892 of them, yes — unambiguously.** They are deployed
or active vehicles, fitted with a device, that the source has never received a single GPS fix from.
Not undeployed (zero of them), not warehoused, not stale. A brand-new install that never came up is
exactly what this looks like, and FSM reports every one as "reporting normally."

**Three sub-populations fall out, and only the first was previously known:**

1. **892 genuine NDD** — never reported at source, never reported in FSM. The defect as described.
2. **15 devices where FSM is wrong about the null itself** — AutoPlant *has* GPS for them, 14 within
   the last 24 hours, and FSM stored NULL. This is a **separate ingestion gap**, not a counting
   defect, and neither report found it. These devices are doubly misreported: FSM has lost real
   telemetry *and* then counted the loss as health.
3. **6 devices FSM holds that the source no longer has at all** — orphaned mirror rows.

The two reports' NDD counts (mine 913 fleet-wide, yesterday's 46/51 for Nuvista) are consistent —
yesterday scoped to one company, I scoped fleet-wide. Nuvista's share today is 38.

Fleet-wide distribution is highly concentrated:

| Company | NDD counted healthy |
|---|---:|
| Vasavadatta | **545** |
| Deepak Fertilizer | **208** |
| Nuvista | 38 |
| Prism Cement | 25 |
| HCCB | 13 |
| SAURASHTRA CEMENT | 12 |
| Testing Company | 11 |
| UTCL | 11 |
| Vicat Inbound | 10 |
| Zuari Cement | 8 |
| *(remainder)* | 42 |
| **Total** | **913** |

Vasavadatta and Deepak Fertilizer carry 82% of it. For those two companies specifically, the
dashboard's health figure is materially fiction — this is not a rounding-error defect at company
scope.

### 2.2 Why does this happen at all? — the reasoning that produced it

I traced this through git, the issue backlog, and `docs/kpi-definitions.md`. The answer is not
"someone forgot a NULL check." It is more interesting and more uncomfortable than that.

**The NULL case *was* considered — at the state layer.** `device-state.service.ts:108`:

```sql
is_inactive = (NOT dr.departed AND dr.hours IS NOT NULL AND dr.hours >= ${threshold}),
```

`dr.hours IS NOT NULL` is an explicit, deliberate guard. Whoever wrote this knew a device could have
no GPS and consciously decided such a device must not be called *inactive*. That is a correct local
decision — "we have never heard from it" genuinely is not "it went silent."

**The failure is that the guard was never followed through to the consumers.** Having been excluded
from `inactive`, the device was then swept into `healthy` by a predicate defined as the negation.
The NULL was handled once, locally, and then leaked globally.

**And the binary was subsequently hardened on purpose.** `docs/kpi-definitions.md` §"Healthy
Operational Devices" says, in the author's own words:

> **Formula** `COUNT(device_states WHERE is_departed = false AND NOT (is_inactive = true AND sla_bucket IS NOT NULL))`
> **Reconciles** `healthy + inactive = operational`, exactly, at every level.
>
> *"Counted directly rather than subtracted, over the complement predicate on the same non-departed
> set — so the identity holds by construction rather than by arithmetic that could be applied
> inconsistently."*

That paragraph is the moment the third state became unrepresentable. The two-state identity was not
an accident — it was **engineered as a guarantee**, and the engineering that guaranteed it is exactly
what forecloses NDD. The same doc defines healthy in prose as *"operational devices **reporting
normally** — deployed, tracked, and not inactive."* The prose says "reporting normally." The SQL says
"not inactive." A device that has never reported satisfies the SQL and contradicts the prose, and
nothing in the system compares the two.

**Was NDD ever considered?** No. `docs/kpi-definitions.md` contains **zero** occurrences of `NDD`,
"never reported", "no data", or any null-GPS discussion. The concept does not appear in the KPI
catalogue, the dashboard design, or any issue in `.scratch/fsm-platform-v1/`. Git confirms the
predicate has been essentially unchanged since `85da11c feat: initial FSM platform foundation` and
was only ever *reinforced* (`786b080`, `77dc6b9`, `ba6053c`, `9c00ad6`), never revisited.

**Verdict, stated plainly as you asked: the state was simply never modelled.** The never-reported
case was noticed at one layer, defended against locally, and then never promoted to a domain concept.
Confidence: **high**.

### 2.3 How far does it reach? — every affirmative-positive, with counts

This is the part neither report did. `healthyOperational` is the visible tile; the same
absence-as-positive reading occurs in five more places. All counts are fleet-wide, measured today.

| # | Surface | Code | What a never-reported device is counted as | Devices |
|---|---|---|---|---:|
| 1 | **Dashboard KPI strip / Fleet Health %** | `dashboard.service.ts:43` (`FLEET_COUNT_COLUMNS`) | *Healthy* | **913** |
| 2 | **Fleet Directory device filter** | `dashboard.service.ts:682` | Returned under the *healthy* filter | **913** |
| 3 | **Device list `status=ACTIVE` filter** | `device.service.ts:304` — `AND ds.is_inactive = false` | *Active* | **913** |
| 4 | **Fleet Uptime %** | `fleet-uptime-aggregation.service.ts:52` + `eligible_for_uptime` | **100% uptime** — eligible, and no `failure_cycles` row, so zero downtime | **913** |
| 5 | **Soft-Inactive count / Activity Trend denominator** | `soft-inactive-count.service.ts:60-61,84-85,112-113`; `dashboard.service.ts:899` | In the *eligible* denominator, never in the *silent* numerator → depresses the inactive rate | **913** |
| 6 | **Entity-mapping export** | `entity-mapping-export.service.ts:35,109` | Exports `eligible_for_uptime = true` with a blank GPS column | **913** |

It reaches all six identically because `eligible_for_uptime` is `true` for **all 913** — the
`eligibility_mode` system setting is currently `all-deployed` (the declared interim proxy while the
SAP PGI feed is unbuilt), so eligibility is decided by deployment status alone and a null GPS is no
obstacle.

**Surface 4 is the worst of them and was missed by both reports.** Fleet Uptime is computed as
failure-cycle overlap over the month window. A device that has never reported has never opened a
failure cycle, because failure cycles are opened from inactivity, and inactivity requires a
timestamp. So it contributes a **full month of zero downtime to the numerator of the uptime KPI**.
The single most broken device in the fleet is scored as the healthiest possible device. For
Vasavadatta (545 NDD) this is not a marginal distortion.

**Where it does *not* reach — checked and cleared:**

- **Ticket creation:** gated on `eligible_for_uptime = true` **and** an inactivity-driven failure
  cycle (`non-operational.service.ts:430`). NDD devices are eligible but never become inactive, so no
  ticket is ever created. **They are invisible to field operations rather than falsely ticketed** —
  which is a different harm, not an absence of harm: 892 deployed vehicles with dead devices, and not
  one work order between them.
- **SLA bucketing:** `sla_bucket` stays NULL for NDD devices. Correct.
- **Dispatch eligibility / recommender:** consumes tickets, and there are none. Not reached.
- **Departure invariant** (`departure-invariant.ts`): checks departed-vs-operational only. Blind to
  this.

So the honest summary of reach is: **six read surfaces overstate health, and the ticketing path
silently omits 892 genuinely broken devices.** The dashboard tile is the least consequential item on
that list.

### 2.4 What the correct model is

The Excel is right and FSM is wrong on the domain, not just the query. The Excel's totals only close
as `active + inactive + NDD` — it treats NDD as a peer third state. FSM has no representation of it.

**Minimum viable fix — one release, low risk.**

Change nothing in the schema; derive the third state from the NULL that is already there.

1. Add a fourth counter to `FLEET_COUNT_COLUMNS`:
   `neverReported = COUNT(*) FILTER (WHERE is_departed = false AND latest_gps_datetime IS NULL)`.
2. Narrow `healthyOperational` to require `latest_gps_datetime IS NOT NULL`.
3. Change the stated identity from `healthy + inactive = operational` to
   `healthy + inactive + neverReported = operational`, and update
   `reconciliation.service.ts:205` and `kpi-definitions.md` to match.
4. Exclude NDD from `eligible_for_uptime` (or from the uptime denominator) so surface 4 stops
   scoring them as perfect.
5. Add the tile/column to the dashboard and the Fleet Directory filter.

**Cost:** roughly a day of engineering, one migration-free deploy. **What it does not give you:** any
way to distinguish *"newly installed, commissioning in progress"* from *"installed six months ago and
never worked."* Those are operationally opposite and the MVP fix reports them identically.

**The correct model — a real domain state.**

NDD is not one state. It is at least two, and the difference is the entire operational point:

- **Commissioning** — fitted recently, expected to be silent, not yet a fault. Needs a grace window.
- **Dead-on-arrival** — fitted, grace window elapsed, never reported. This is a *ticketable fault*,
  arguably the highest-priority class in the fleet, because the vehicle has been running untracked
  since the day it was fitted.

Expressing that requires something FSM does not currently have: **a commissioning/first-fitment
date.** Without a "when did we start expecting data from this device" timestamp, you cannot compute a
grace window, and you cannot tell the two apart. Concretely:

- **Schema:** a `device_commissioned_at` (or first-seen-in-master) column on `devices`/`device_states`,
  backfilled from `master_sync_runs` history where available and from AutoPlant's fitment/install
  data where not. This is the load-bearing piece and the reason this is not a one-day job — the
  source column may not exist, in which case backfill is best-effort and the historical population is
  permanently ambiguous.

> **RESOLVED (2026-08-07).** The source column exists and is better than hoped.
> `ap_widgets.tb_vehiclemaster.FIRST_INSTALLED_DATE_TIME` is **100% populated** on the 907 NDD
> devices found at source, with no future and no pre-2000 values. Validated rather than assumed: on
> 21,244 devices that pinged within the last 24 h it predates the first ping on **21,238**, with
> **0 bogus** rows. Age distribution on the 907: **602 (66%) fitted over a year ago**, 153 within
> 2 days. FSM ingests none of these columns today, so mirroring one is required work. The "permanently
> ambiguous historical population" concern does not apply.
- **Semantics:** a `device_report_state` enum — `REPORTING | SILENT | COMMISSIONING | NEVER_REPORTED`
  — replacing the boolean `is_inactive` as the primary state, with `is_inactive` retained as a derived
  compatibility view so nothing downstream breaks on day one.

> **CORRECTION (2026-08-07, during the #223 design pass).** The next paragraph claimed the
> failure-cycle machinery "is entirely transition-driven and cannot represent 'was never good'."
> **That is wrong.** `ticket-creation.service.ts:34-52` is a **state scan** —
> `where: { isInactive: true, eligibleForUptime: true, hasOpenFailureCycle: false }` — with no
> transition detection anywhere; `hasOpenFailureCycle` plus the I1 partial-unique is the dedup.
> The moment `is_inactive` becomes true for a never-reported device, the existing code creates the
> cycle and the ticket with **no changes at all**, and `AutoRecoveryService` closes it correctly if
> the device later comes alive. All 913 already satisfy every ticketing precondition. **The piece of
> work I flagged as the hard part does not exist.** Full detail in
> [#223](../.scratch/fsm-platform-v1/issues/223-ndd-counted-healthy.md).

- **What else has to change:** Fleet Uptime needs a decision on whether a DOA device is 0%
  uptime or excluded; the SLA bucketing needs a band for "never" (currently `NULL`, which the UI
  renders as blank); every export and the Ops Explorer registry need the new column.

**Cost:** a genuine slice — schema migration, backfill of ~26.5k devices, a new ticket-creation path,
and UI across dashboard/directory/reports/exports. Realistically 1–2 weeks, and it is gated on an
answer to "does AutoPlant know when a device was fitted?" which I have not established.

**Honest recommendation on which:** do the MVP fix now, because six surfaces are actively lying and
the fix is cheap and reversible. Do **not** treat it as done — file the correct model as a follow-up
with the commissioning-date question as its first investigation step. The MVP fix makes the numbers
honest; only the correct model makes the 892 devices *actionable*, and actionability is the entire
point of the platform.

### 2.5 What breaks if we fix it

Every rate built on the `operationalDevices` denominator moves. Measured, fleet-wide, today:

| Scenario | Fleet Health % | Operational | Healthy |
|---|---:|---:|---:|
| **As shipped today** | **82.96%** | 15,696 | 13,021 |
| NDD removed from healthy *and* from the denominator | **81.90%** | 14,783 | 12,108 |
| Timestamp fix only (§3), NDD untouched | **85.72%** | 15,696 | 13,455 |
| **Both fixes** | **84.84%** | 14,783 | 12,542 |

Note the interaction, which is the most important line in this table: **the two defects push Fleet
Health in opposite directions and have been partially cancelling each other.** NDD inflates it by
~1.1 points; the timestamp shift deflates it by ~2.8 points. The net error today is about −1.9
points, but the gross error is ~3.9 points and it is not stable — it moves with the NDD population
and with how many devices happen to sit in the 18.5–24h window at any moment. A figure that looks
roughly right for two compensating wrong reasons is worse than one that is visibly wrong.

**Downstream assumptions on today's definition — found, and they are the awkward part:**

1. **`reconciliation.service.ts:205` asserts `healthyOperational + inactiveOperational = operationalDevices`.**
   The MVP fix **breaks this assertion** and the Ops Explorer reconciliation panel will report a
   failure until the identity is updated. This must ship in the same change.
2. **`docs/kpi-definitions.md` states `Inactive % + Fleet Health % = 100%` for every row** as a
   reconciliation guarantee. That guarantee becomes false. The doc is authoritative per CLAUDE.md and
   must be edited in place.
3. **`dashboard.service.ts:25` and `:59-60` carry the same claim in code comments**
   (`operational = healthy + inactive`, "complementary predicates over the same non-departed set").
4. **The Fleet Composition funnel** (`dashboard.controller.ts:85`, `dashboard.service.ts:185`)
   renders `operationalDevices → healthyOperational + inactiveOperational` as a two-way split and
   needs a third branch or the funnel will not sum.
5. **`soft_inactive_count_history`** already holds snapshotted denominators computed under the old
   definition. Historical trend charts will show a step discontinuity on the day of the fix. That is
   correct behaviour but needs to be expected rather than treated as a regression.

Nothing else assumes the binary. Ticket creation, dispatch, and the SLA bands are unaffected because
NDD devices never entered them.

### 2.6 Recommendation

**Ship the MVP fix (§2.4) as one slice**, together with the reconciliation-identity update, the
`kpi-definitions.md` edit, and the uptime-eligibility exclusion. **Confidence: high** that this is
correct and safe. Do it *after* or *with* the timestamp fix, not before — shipping it alone moves
Fleet Health the "wrong" way (down 1.1 points) with none of the offsetting correction, and that will
be read as a regression by anyone watching the tile.

**File the correct model separately**, opening with the commissioning-date investigation.
**Confidence: medium** on the design as sketched, because it depends on source data I have not
confirmed exists.

**Product decisions, not engineering** — these need you, and I have deliberately not chosen:

- **P1.** Is a never-reported device a *fault* (ticketable, dispatchable, SLA-bound) or a *pipeline
  state* (commissioning, invisible to field ops until a grace period elapses)? Everything else
  follows from this and it is a business-rule question about how installs are run.
- **P2.** If it is a fault, what is the grace window — days from fitment before DOA is raised?
- **P3.** Does a never-reported device count as 0% uptime, or is it excluded from Fleet Uptime
  entirely? This changes contractual reporting and is a commercial question, not a technical one.
- **P4.** Should the dashboard show a fourth tile, or fold NDD into a widened "not reporting" figure
  alongside inactive? The Excel's audience already reads three states; FSM's may not.
- **P5.** Vasavadatta (545) and Deepak Fertilizer (208) will see their health figures drop
  noticeably. Is there a customer-communication step before this ships?

**Engineering, no decision needed:** the six read surfaces, the reconciliation identity, the doc
edits, the funnel third branch, the uptime-eligibility exclusion, and — separately from all of this —
**the 15 devices where FSM stored NULL over real source telemetry**, which is an ingestion bug that
should be triaged on its own regardless of what you decide about NDD.

---

## 3. The second question — the disagreement, resolved

**Answer: the defect is real and is a timezone double-conversion. Yesterday's report is wrong on
this point. My PRISM report is right about the defect and wrong about its cause.**

I did not split the difference and I am not softening either half of that.

### 3.1 The source probe, re-run by hand today

```
@@global.time_zone    SYSTEM
@@session.time_zone   SYSTEM
@@system_time_zone    UTC
NOW()                 2026-08-07 11:48:30
UTC_TIMESTAMP()       2026-08-07 11:48:30      TIMESTAMPDIFF = 0 sec
```

Host wall clock at that instant: `11:48:31 UTC` / `17:18:31 IST`. The server is UTC and its clock is
accurate to the second.

Newest `latest_gps_datetime`:

| Scope | Value | Reads as |
|---|---|---|
| Satna (`plant_id` 3121+3122) | `2026-08-07 11:48:17` | **UTC** |
| **Fleet-wide `MAX()`** | `2026-08-07 17:18:16` | **IST** |

That contradiction is the whole story, so I chased it.

### 3.2 The fleet is not mixed — it has five outliers, and they poisoned the original verification

Counting how many devices sit *ahead* of UTC-now (impossible if the column is UTC):

| Bucket | Devices |
|---|---:|
| `> UTC_now + 5h` — IST-stored, fresh | **4** |
| `> UTC_now` — IST-stored, older | **1** |
| within last 24 h UTC | 21,245 |
| older than 24 h UTC | 35,314 |

**Five devices out of 56,564.** They sit at plants `GSR`, `SCNEL GHY CEMENT`, and
`ACC CEMENT LIMITED-LONI KALBHOR` — a handful of third-party units writing IST into a UTC column.
They are 0.009% of the fleet and they are the entire reason `MAX()` reads as IST wall clock.

**This is exactly the statistic `mapping.ts` used to establish the contract.** Its own comment:

> *Verified against the live source 2026-07-17: server `NOW()` (UTC) 06:20:32 · newest
> TRIP_CREATION 06:19:02 · newest `latest_gps_datetime` **11:49:46** · real IST wall clock **11:50**.*

Newest = `MAX()`. On 2026-07-17 that gave 11:49:46 against an IST wall clock of 11:50 — a 14-second
gap. Today the same probe gives 17:18:16 against 17:18:31 — a **15-second gap**. Identical signature,
one month apart. The 2026-07-17 verification did not observe an IST column; it observed the same five
outlier devices, and generalised from a maximum to a population.

### 3.3 Did the source change? — tested directly, and the answer is no

`raw_device_snapshots.gps_datetime` stores the **post-conversion** value, and `snapshot_runs` records
when each run ran. That lets me time-travel the source contract: for any historical run, if the
conversion were correct, the freshest normalised GPS should sit ~0h behind the run's own finish time;
if FSM were over-subtracting 5.5h, it should sit ~5.5h behind.

I ran this per-run across every run from 2026-07-07 to today. Using `MAX()` it looked clean (~0.03h
lag on every run) — **because `MAX()` picks the IST-writing outliers, for whom `+330` genuinely is
correct.** The same trap, a third time. Using percentiles, which are immune to five devices:

| Run | Finished (UTC) | Rows | p50 lag | p10 lag | p01 lag |
|---|---|---:|---:|---:|---:|
| 2 | 07-07 04:51 | 21,945 | 5.592 | 5.552 | 5.536 |
| 26 | 07-08 06:29 | 18,627 | 5.594 | 5.565 | 5.552 |
| 91 | 07-21 11:23 | 19,109 | 5.582 | 5.541 | 5.527 |
| 95 | 07-23 06:09 | 20,988 | 5.623 | 5.573 | 5.555 |
| 107 | 07-29 12:32 | 19,263 | 5.571 | 5.552 | 5.532 |
| 110 | 08-03 04:09 | 21,975 | 5.571 | 5.540 | 5.524 |
| 148 | 08-06 05:01 | 21,055 | 5.606 | 5.549 | 5.531 |
| 151 | 08-07 01:45 | 20,578 | 5.566 | 5.537 | 5.523 |
| **152** | **08-07 10:02** | **20,466** | **5.571** | **5.542** | **5.534** |

*(95 runs measured, all with >5,000 rows; the table is a representative slice. Every single run sits
in the 5.52–5.65h band.)*

**Flat. No discontinuity, on any date, including across 2026-07-17.** FSM has been subtracting 5.5
hours it should not have subtracted since the very first snapshot run on 2026-07-07.

Device-level confirmation, run 152 (ran 09:58–10:02 UTC):

| device | source raw (now) | FSM stored (UTC) | reading |
|---|---|---|---|
| 867542081342639 | 11:50:38 | 04:31:09 | source was ~10:01 at run time → **stored = source − 5:30** ✗ |
| 869645080575378 | 11:50:49 | 04:31:08 | same ✗ |
| **860103064768360** | **17:20:15** | **09:58:34** | IST-writer: 15:28 IST at run time → 09:58 UTC ✓ **correct** |

And the bimodality on the newest run makes the population explicit:

| Lag bucket | Devices |
|---|---:|
| `<1h` — IST-writing device, `+330` is correct | **4** |
| `5.0–6.0h` — UTC-writing, over-subtracted | **18,486** |
| `>6h` — genuinely stale device | 1,976 |

**Conclusion: AutoPlant never changed.** `latest_gps_datetime` has been UTC for the entire life of
this integration. `AUTOPLANT_UTC_OFFSET_MIN = 330` was wrong when it was written, and the
verification that blessed it was measuring five anomalous devices. **My PRISM report's claim of an
IST→UTC source change is withdrawn.** Confidence in the withdrawal: **high** — the time-travel
evidence is direct, spans a month, and is robust to the outliers that fooled everyone.

This also changes the fix. It is still a one-line constant, but:

- There is **no vendor conversation to have** and no announcement to chase. Open question 1 in my
  PRISM report is void.
- Flipping the constant to `0` will push those 4–5 IST-writing devices 5.5h into the *future*, where
  `mapping.ts:168`'s skew guard will reject them and they will stop ingesting. That is arguably the
  correct outcome (their data is genuinely mislabelled at source) but it should be a conscious
  decision, not a surprise.
- **`apps/backend/test/autoplant-mapping.spec.ts:131` asserts `expect(AUTOPLANT_UTC_OFFSET_MIN).toBe(330)`.**
  That test does not verify the contract — it pins the wrong value in place and will fail on the fix.
  It has to be deleted or rewritten as a live source probe.

### 3.4 How yesterday reached "5.1h, therefore not a timezone bug"

Yesterday's reasoning was: *an IST double-conversion produces exactly 5h30m; I measured 5.1h;
5.1 ≠ 5.5; therefore not a timezone bug.* The premise is right, the measurement is right, and the
inference is wrong — because yesterday compared FSM against **the Excel**, not against the live
source, and the two were read 25 minutes apart.

Reconstructing yesterday's own numbers under the timezone hypothesis:

- Excel snapshot instant: `06:49:21 IST` = **01:19:21 UTC** (yesterday's own assumption 3).
- FSM snapshot run 151: finished **01:45 UTC** — **~25 minutes later**.
- For a **live** device, the Excel captured `≈01:19 UTC`; FSM read `≈01:44 UTC` from the source and
  stored `01:44 − 5:30 = 20:14 UTC`. Delta = `01:19 − 20:14` = **5h05m ≈ 5.10h**.
- For a **frozen** device (stopped pinging before both reads), both systems see the same fixed source
  value `V`. Excel renders `V` correctly; FSM stores `V − 5:30`. Delta = **exactly 5.5000h**.

Yesterday's reported distribution:

```
min -5.50h · p05 -5.50h · p25 -5.15h · p50 -5.10h · p75 -5.10h · p95 -5.05h
```

Every feature of that line is predicted: a **hard floor at exactly −5.50** (frozen devices), a
**median at −5.10** (live devices, offset by the 25-minute read gap), and a **total spread of ~27
minutes** — matching the gap between the two reads. The timezone hypothesis explains the shape
exactly. A staleness hypothesis cannot: stale data produces a *long tail* — older devices are more
stale — and there is no mechanism by which staleness stops dead at 5.50h and never exceeds it. The
floor yesterday reported as `min` and `p05` **was the bug's signature**, sitting in its own output.

The report also noted the corroborating detail and read it the other way: *"snapshot run 151
completed at 07:15 IST yet the freshest GPS in `device_states` is 01:44 IST, so this is not simply
'no run since'."* `07:15 IST − 5:30 = 01:45 IST`. The "staleness" **is** the shift, to the minute.
And the inference that run 151's 3m19s duration indicated an incomplete pass does not hold: run 151
wrote 20,578 rows, in line with every healthy run in the table above.

**So both reads made the same class of error in mirror image.** Yesterday compared FSM to a
*snapshot* and let a 25-minute read gap disguise a constant as a variable. I compared FSM to the
*live source* correctly, got the constant right — and then explained it with a source change I
inferred from `mapping.ts`'s comment rather than testing. Yesterday inferred IST from the comment and
measured against the wrong reference; I measured against the right reference and inferred the history
from the comment. Neither of us tested the historical record until now.

### 3.5 Where that leaves the impact figures

The impact numbers in my PRISM report are unaffected by the cause correction and I re-measured them
today: **434 devices fleet-wide are falsely inactive** (2,675 counted inactive; 2,241 with the shift
backed out), out of 15,696 operational. **~16% of the entire inactive queue is fabricated.** Because
`sla_bucket` derives from the same inflated `inactivity_hours`, severity bands are inflated with it,
so this propagates into ticket priority, SLA reporting and Fleet Uptime. Confidence: **high**.

---

## 4. The third question — is there a pattern?

**There is, it is real, and it is sharper than "insufficient testing." I am not forcing a narrative;
I would tell you if I thought these were three separate bugs.**

### The pattern: *every guard in this system is one-directional, and each one fails toward "fine."*

Look at what each defect's supposed safety mechanism actually checks:

| Defect | The guard | Direction it checks | Direction the bug travels |
|---|---|---|---|
| **#218** — dead lifecycle pass | `@Optional()` + `if (!this.departures) return;` | *Is the dependency present?* If absent → `undefined` → **early return reported as success** | Absent |
| **NDD as healthy** | `reconciliation.service.ts:205`: `healthy + inactive = operational` | Are the counts consistent? | The two predicates are **literal complements**, so this is a tautology |
| **Timestamp offset** | `mapping.ts:168`: reject if `gpsDatetime > now + skew` | Timestamps in the **future** | Timestamps in the **past** |

Three guards. Not one of them can fail in the direction its own bug travels. That is not three
coincidences — it is one habit of mind: **the guard is written against the failure the author
imagined, and the failure that actually occurred is its mirror image.**

The reconciliation check is the clearest specimen, because the code says so out loud
(`reconciliation.service.ts:213`):

> *"The two predicates are literal complements within one SQL fragment, so a mismatch here is not a
> data problem — it means `FLEET_COUNT_COLUMNS` itself has been edited such that healthy is no longer
> `NOT(inactive)`."*

The author knew the check was tautological and shipped it in a panel labelled *reconciliation*. It
can detect a developer editing SQL. It cannot detect a single wrong number. It has been green,
continuously, over 913 misclassified devices.

### The second, compounding half: nothing re-measures the world

Every one of these survived because **the system only ever tests itself against its own assumptions**:

- `autoplant-mapping.spec.ts:131` asserts `AUTOPLANT_UTC_OFFSET_MIN === 330` — a test that pins a
  wrong constant and would have gone red on the correct fix. It tests that the code says what the
  code says.
- Every mapping/normalisation test constructs its own input rather than reading the live source, so a
  source contract that was never true could not be falsified by the suite.
- Every `MasterSyncService` test constructs the service by hand, bypassing Nest DI — which is
  precisely the layer where #218 lived. The NUVISTA report established this and it holds.
- `kpi-definitions.md` records "Live value: 13,939 pan-India" — a number, copied in, never re-derived.

And the recurring third element, which I hit **three times today**: **`MAX()` as a contract probe.**
The 2026-07-17 verification used it, my own time-travel test used it, and the Ops Explorer freshness
surfaces use it. A maximum over 56,564 rows is decided by the single most anomalous row in the
table. Five misbehaving devices out of 56,564 have been defining this integration's timezone contract
for a month.

### What would catch the whole class

Not more unit tests — they are the wrong instrument, and adding a test for each of these three would
catch exactly these three. Four things, roughly in order of value:

1. **Make one invariant per subsystem *falsifiable against reality*, and delete the tautological
   ones.** `healthy + inactive = operational` must be replaced by a check against an independent
   source — e.g. *"every operational device is in exactly one of {reporting, silent, never-reported},
   and the three sum to the count AutoPlant reports for the same plant."* If a check cannot go red
   for a data reason, it is documentation wearing a check's clothing, and it is worse than nothing
   because it occupies the slot where a real check would go.
2. **A source-contract monitor that re-measures on every run, using percentiles, not extremes.**
   One assertion would have caught the timestamp defect on 2026-07-07: *the p50 of
   `run.finished_at − normalized_gps` must be under 1 hour.* It has been 5.58h on all 95 runs.
   Generalise: for each ingested field, record a distributional fingerprint per run and alert on
   drift. This also catches the 15 devices where FSM stored NULL over real telemetry.
3. **Every "nothing happened" must be distinguishable from "nothing to do."** #218 returned early and
   reported success; NDD devices produce no ticket and no signal. A pass that processes zero records
   should emit a *typed* zero — `SKIPPED_DEPENDENCY_MISSING` vs `NO_WORK` — and any sweep whose
   output is structurally zero should be loud. `@Optional()` without an explicit `@Inject()` token
   should be banned by lint outright; it converts a boot-time error into a silent runtime no-op, and
   this repo has now been bitten by import-type erasure three times (`f813b39` #217, #218's
   `master-sync.service.ts` ×2).
4. **A boot-time DI smoke test.** Instantiate the real Nest application context and assert every
   `@Optional()` collaborator that is expected in production actually resolved. This is one test file
   and it kills the entire #218/#217 class permanently.

### The honest caveat

The three defects are not *the same bug*, and I am not claiming a single fix addresses them. #218 is
a DI/compilation issue, NDD is a domain-modelling gap, and the timestamp is a source-contract error.
What they share is not a mechanism but a **failure mode**: each produced plausible output, each
passed every check that existed, and in each case the check that existed was incapable of failing.
The common cause is a testing and observability posture that verifies the system against its own
beliefs and never against the world. That is one thing, and it is fixable.

Confidence: **high** on the one-directional-guard pattern (three specimens, each verifiable in the
code, plus the author's own comment admitting the tautology). **Medium** on my proposed remedies
being sufficient — they are the ones I would start with, not a proof of coverage.

---

## 5. What needs your decision vs. what is engineering work

### Product / business decisions — yours

| # | Decision | Blocks |
|---|---|---|
| **P1** | Is a never-reported device a **fault** (ticketable, dispatchable, SLA-bound) or a **pipeline state** (commissioning, invisible until a grace period elapses)? | The entire correct-model design |
| **P2** | If a fault: what grace window from fitment before DOA is raised? | Ticket-creation path |
| **P3** | Does a never-reported device count as **0% uptime** or is it **excluded** from Fleet Uptime? Contractual/commercial. | Uptime reporting, customer-facing |
| **P4** | Fourth dashboard tile, or fold NDD into a widened "not reporting" figure? | Dashboard/Directory UI |
| **P5** | Vasavadatta (545) and Deepak Fertilizer (208) see visible health drops. Customer communication first? | Release sequencing |
| **P6** | Flipping the offset to 0 will stop ingestion for the 4–5 IST-writing devices (skew guard rejects them). Accept, or special-case them? | Timestamp fix |
| **P7** | Ship order. My recommendation: **timestamp fix first, NDD fix immediately after or together.** NDD alone moves Fleet Health *down* 1.1 points with none of the offsetting +2.8 correction. | Release sequencing |

### Engineering work — no decision needed

1. **Timestamp fix.** Set `AUTOPLANT_UTC_OFFSET_MIN = 0`; delete or rewrite
   `autoplant-mapping.spec.ts:131`; correct the now-false provenance comment at `mapping.ts:17-30`.
   Then recompute `device_states` — ~434 devices leave the inactive queue.
2. **NDD MVP fix.** The five items in §2.4, plus updating `reconciliation.service.ts:205`,
   `kpi-definitions.md`, `dashboard.service.ts:25/59-60`, and the Fleet Composition funnel.
3. **The 15 devices where FSM stored NULL over real source telemetry** (14 pinged within 24h). A
   distinct ingestion bug. Triage independently of everything above.
4. **The 6 mirror rows absent from source.** Orphan cleanup.
5. **Guard hardening** (§4): a boot-time DI resolution test; a lint ban on `@Optional()` without
   `@Inject()`; a per-run distributional source-contract monitor; replace the tautological
   reconciliation identity with a falsifiable one.

### Withdrawn / corrected from the earlier reports

- **PRISM report, F1 cause:** "AutoPlant changed `latest_gps_datetime` from IST to UTC between
  2026-07-17 and 2026-08-07" — **withdrawn.** The source never changed. The defect and its impact
  figures stand unchanged.
- **PRISM report, open question 1** ("was the source change announced?") — **void**, no change
  occurred.
- **NUVISTA report, F2:** "This is not a timezone bug… FSM's conversion is correct; its *data* is
  old" — **withdrawn.** It is a timezone bug; the conversion is wrong and the data was fresh. The
  report's harm analysis (80 devices false-inactive in the 18.2–24.0h window) was correct and is
  strengthened, not weakened, by this.
- **NUVISTA report, F2 side note:** run 151's short duration indicating an incomplete pass — not
  supported; it wrote 20,578 rows, in line with every healthy run.
- **Both reports** understated the NDD blast radius: it is six read surfaces, not one tile, and
  Fleet Uptime — where NDD devices score as 100% — is the worst of them.

**Not done, deliberately:** no issues filed, no source changed, no sync run, no data written. Nothing
outside this file was touched.
