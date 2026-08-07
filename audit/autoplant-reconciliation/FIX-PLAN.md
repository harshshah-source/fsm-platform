# Fix Plan — departure/restore pass dead under Nest DI

> **ADDENDUM (Stage 1, round 2)** — blocker resolved, estimates replaced with exact counts.
> §0A supersedes the sampled figures in §0. §5 is **corrected**: the contradiction check will not
> reach 0. §3 Trap A is **substantially reframed**. See §0A.

**Stage 1 proposal. Nothing implemented. No source edited, no migration written, no sync run.**
Proposed issue number: **#218** (next free; #217 is the highest in INDEX.md).

Out of scope by your instruction, noted as follow-ups: **F2** (~5.1 h telemetry staleness) and
**F3** (never-reported devices counted as healthy). Neither is touched here.

---

## 0. Corrections to what I told you earlier

Two numbers changed under closer sampling. Both matter to the change window, so they lead.

**Correction 1 — the restore count is ~1,230, not 2,197.**
I reported 2,197 "missed restores" pan-India. That figure counted devices where *FSM's own mirror*
(`vehicles.status`) says DEPLOYED. A random 270-device sample of open departures, checked against
production `mst_vehicle`, shows what those actually are:

| FSM mirror | AutoPlant source today | n | % |
|---|---|---:|---:|
| UNDEPLOYED | UNDEPLOYED | 167 | 61.9% |
| DEPLOYED | DEPLOYED | 53 | 19.6% |
| **DEPLOYED** | **ABSENT from `mst_vehicle`** | **42** | **15.6%** |
| UNDEPLOYED | ABSENT | 7 | 2.6% |
| MAINTENANCE | MAINTENANCE | 1 | 0.4% |

Only **~56%** of the "FSM says DEPLOYED" group is genuinely DEPLOYED at source. The rest have
**vanished from the source table**, and FSM's mirror is frozen at whatever it last saw. So of the
2,197: **~1,230 will actually restore, ~970 will not** (correctly — we cannot confirm a redeployment
for a device we cannot see).

Revised change-window volume: **~4,030 departures + ~1,230 restores ≈ 5,260 records**, not ~6,200.

**Correction 2 — the Nuvista finding is unaffected.**
I re-sampled the 795 Nuvista cohort randomly (180 devices): **95.0% DEPLOYED at source**, 5.0%
absent. That matches my earlier 85/90 systematic sample and the figures you verified by hand.
The Nuvista evidence stands; it was the *pan-India extrapolation* that was too optimistic.

> Measured vs estimated: the 270- and 180-device samples are measured; the extrapolations to 6,767
> and 4,028 are estimates with roughly ±6% at 95% confidence. Exact counts are marked *(exact)*.

---

## 0A. Blocker resolved — "absent from source" is real, and here is what it means

### First, a scope correction in my favour that I should have stated plainly

**The absence check never used the 22-plant list.** It was
`SELECT device_id FROM ap_masters.mst_vehicle WHERE device_id IN (...)` — no plant filter, no company
filter, no status filter. "Absent" already meant *not present in `mst_vehicle` anywhere*. The
FSM-derived plant list was used only for the row-count comparisons (the 26,370 figure in F5). I buried
that distinction and you were right to challenge it.

### The authoritative AutoPlant scope, established

`mst_company` → `mst_plant.company_id` → `mst_vehicle.plant_id` is the authoritative chain.

| company_id | company_name | plants |
|---|---|---|
| 1004 | `Nuvista` | 22 ACTIVE + 1 INACTIVE |
| 1005 | `NuVista` | **0 plants** — a duplicate/empty company record |
| 1071 | `Nuvista Rakesiding` | 1 ACTIVE |

**My FSM-derived list was a strict subset and contained nothing spurious**: all 22 of its plants are
authoritative; it was missing 2 (`30933`, `4560` — the INACTIVE plant and the Rakesiding plant).

Vehicles under the authoritative scope, ACTIVE plants: UNDEPLOYED 18,620 + DEPLOYED 7,805 +
ACTIVE 40 = **26,465** *(exact)*. Against the Excel's 25,214 — so **F5's gap widens slightly to 1,251
under the correct scope, and remains unexplained.** Note `deployment_status = 'ACTIVE'` exists (40
vehicles) and counts as operational.

### The absence check, re-run under authoritative scope — exact, all 6,767, no sampling

| State in AutoPlant today | n | % |
|---|---:|---:|
| `UNDEPLOYED`, plant ACTIVE — correctly departed | 4,464 | 66.0% |
| **ABSENT from `mst_vehicle`** | **1,153** | **17.0%** |
| `DEPLOYED`, plant ACTIVE — should restore | 1,139 | 16.8% |
| `UNDEPLOYED`, plant INACTIVE | 6 | 0.1% |
| `MAINTENANCE`, plant ACTIVE | 5 | 0.1% |

**The 44% survives.** Exact, for the restore-candidate cohort (n = **2,197**, exact):

| | n | % |
|---|---:|---:|
| `DEPLOYED`, plant ACTIVE — **will restore** | **1,130** | 51.4% |
| **ABSENT from `mst_vehicle`** — will not | **1,066** | 48.5% |
| `UNDEPLOYED` | 1 | 0.0% |

**Exact restore count: 1,130.** (My sampled estimate was ~1,230; the sample said 56% genuine, exact
is 51.4%.) The plant-status theory does *not* explain absence — only 6 of 6,767 sit at an INACTIVE
plant.

### What "absent" actually means — two mechanisms, both real

I looked the absent devices up by `vehicle_no` instead of `device_id` (sample of 180):

| Mechanism | n | % |
|---|---:|---:|
| **`vehicle_no` also gone — the row is hard-deleted** | 142 | **78.9%** |
| **Vehicle exists, now carries a different `device_id` — device swapped/refitted** | 38 | 21.1% |

Concrete examples of the swap case:
- `KA63A1236` — FSM holds device `860103062421988`; AutoPlant now has `860141074830259` (DEPLOYED)
- `HR56C9358` — FSM holds `862491077868683`; AutoPlant now has `860103064697577` (DEPLOYED)
- `BR21GC3169` — FSM holds `0359688090003921`; AutoPlant now has `861100069819643` (DEPLOYED)

And **0 of 90 absent devices are still present in `ap_widgets.tb_vehiclemaster`** — they are gone
from telemetry too, not merely from the master table.

**Answer to your question: it is hard deletes, not a status I failed to match.** `mst_vehicle` is not
append-only; AutoPlant physically removes rows. This is consistent with the 2026-07-17 investigation,
which recorded the same class ("when a device is unfitted/refitted its `device_id` can disappear from
the table entirely", measured at 3–7%). It is **normal behaviour for this source**, and FSM's
`MISSING_FROM_SOURCE` departure reason exists precisely because of it.

### Consequence 1 — Trap A largely dissolves, and I am withdrawing my framing of it

A device that has been hard-deleted from AutoPlant, and is absent from telemetry too, **should stay
departed**. That is the correct answer, not a stuck state. The 21.1% swap case is also handled
correctly: the old device is genuinely gone, and the vehicle's *new* device_id is created by the
normal insert scope when it is seen DEPLOYED.

So there is no ~1,220-device remediation backlog. What remains is narrower and real:
**`vehicles.status` for those 1,066 devices is frozen at a stale `DEPLOYED`**, because the mirror is
only written for rows the read returns. The departure is right; the mirror is stale. Detection is
still worth having — as a data-quality readout, not as a repair queue. Your "detect only" decision
stands and is, if anything, better supported than when you made it.

### Consequence 2 — §5's contradiction check will NOT read 0 after the fix. Correcting myself.

You asked for a check reading 6,225 now and 0 after. It will not, and I would rather say so now than
have you watch for a zero that cannot arrive. Exact breakdown of today's 6,225 by departure reason:

| Reason for the open departure | Drifting | Resolves at the catch-up? |
|---|---:|---|
| *(no open departure — FSM says operational, source says UNDEPLOYED)* | 4,028 | **Yes** — departed |
| `SOURCE_STATUS` / `UNDEPLOYED` | 1,095 | **Yes** — restored |
| `SOURCE_STATUS` / `MAINTENANCE` | 11 | **Yes** |
| **`ABSENT_FROM_READ` / `MISSING_FROM_SOURCE`** | **1,091** | **No — mirror is frozen by design** |

**Post-fix residual ≈ 1,091, not 0.**

**Revised proposal:** define the check to exclude devices with an open `ABSENT_FROM_READ` departure,
for which the mirror is known-stale by design. Then the correct value *is* 0, the before/after reads
**5,134 → 0**, and the excluded population is surfaced beside it as its own count
("departed, missing from source: 1,091") rather than hidden. That keeps your "unambiguous correct
value" property, which was the whole reason for choosing this metric.

### Consequence 3 — the corrected headline

Real misclassification is **5,158**, not 6,225: the 4,028 missed departures plus 1,130 genuine missed
restores. The other ~1,067 are cases where `is_departed` is **right** and `vehicles.status` is stale —
the reverse of my Q2 diagnostic's assumption. **This strengthens the #130 ruling that the
`device_departures` ledger, not the mirror scalar, is lifecycle truth.** My earlier framing of
`vehicles.status` as "the accurate side" was correct for devices present in the read and wrong for
devices absent from it.

### Your related check — ticketing is NOT inert. Please read this one.

You asked me to verify ticket creation/closure the way I verified the notification seam. They are not
comparable:

| | Status |
|---|---|
| **External notification delivery** | **Inert** — `LoggingChannelGateway` returns `UNAVAILABLE`, nothing sent |
| **Ticket rows** | **Live — writing real rows every day** |

Measured *(exact)*: tickets created **17 today, 87 on 08-06, 71 on 08-05, 96 on 08-04, 222 on 08-03,
2,031 on 07-31**. `ticket_events` mirrors those counts exactly. Totals: **16,727 OPEN / 7,419 CLOSED**.
`batch_assignment_tickets` holds **13,372 rows, 6,573 live, across 8,896 distinct tickets**.

So the **−3,709 / +1,100 movements write real rows into a table that is actively accumulating data**.
If the SE team is developing against this database, the catch-up will change data underneath them:
3,709 rows flipping OPEN→CLOSED, 3,709 new `ticket_events`, and ~1,100 new tickets. That is not a
field-operations risk (no engineer is dispatched, nothing notifies), but it **is** a
developer-environment risk, and it is worth telling the SE team the window is happening even though no
coordination is needed for the field.

---

## 0B. GATE 0 RESULT — `plant_eligible_floating_se` carries no catch-up cost

Measured 2026-08-07, before any code was written. **No production data written.**

| Measure | Value |
|---|---|
| MV `relispopulated` | **true** — so at least one successful REFRESH has run (created `WITH NO DATA`) |
| MV rows | **0** |
| Live recomputation of the MV's defining query | **0** |
| Rows missing from MV / stale in MV | **0 / 0** |
| `engineer_territory_coverage` (the driving table) | **0 rows** |

**The MV is empty because its input is empty, not because it is stale.** No floating-SE territory
coverage has been configured, so the correct contents of this MV today are zero rows — and that is
exactly what it holds. Missing 0, stale 0.

**Conclusion: the second casualty of the erasure bug is currently inert.** Restoring the injection
will make master-sync refresh the MV again, which will be a no-op until territories exist. **There is
no catch-up cost and no impact on the window design.**

Three further points, because "inert today" is not "safe forever":

1. **The MV has three refresh paths, and only one is broken.** On-write (`SeTerritoryService`), the
   daily 04:30 UTC cron (`PlantEligibilityRefreshScheduler`), and post-master-sync (slice 2 — the
   broken one). The cron is **enabled** (`BUSINESS_SWEEPS_ENABLED="true"`) and is provided by
   `useFactory` with an explicit `inject: [PlantEligibleFloatingSeService]` — **it does not carry the
   erasure defect.** So even once territories are configured, the backstop covers the gap within a day.
   This is why the second casualty never surfaced as a symptom.
2. **`relispopulated = true` is positive evidence** that a refresh path executed successfully at least
   once. I cannot prove *which* path or *when* — the scheduler logs but writes no audit row, and there
   is no refresh ledger. That is a small observability gap, worth a line in the follow-up issue, not
   worth fixing here.
3. **Incidental finding relevant to the window:** `INGESTION_SCHEDULER_ENABLED="false"` — confirmed
   from `.env`, not assumed. No scheduled sync can fire the catch-up unattended, which is the
   precondition §7.5 step 1 asks for. It still needs re-verifying at window time.

*Confidence: high.* This is a direct row-level comparison of the MV against a live recomputation of
its own defining SQL, not a sample.

---

## 1. The fix

**Root cause (established, not inferred):** `master-sync.service.ts:2-3` import
`DeviceDepartureService` and `PlantEligibleFloatingSeService` with `import type`. The import is
erased at compile time, so `design:paramtypes` in `dist/.../master-sync.service.js:364` emits
`Object` for both. Neither parameter carries `@Inject()`, so Nest cannot resolve them; `@Optional()`
converts that failure into a silent `undefined`, and `:397` `if (!this.departures) return;` short-
circuits the whole pass.

> **CORRECTED AT GATE 2 (experiment, not reasoning).** The account below calls dropping `type` the
> fix and `@Inject()` the belt-and-braces. **It is backwards.** The parameter type is a union
> (`T | null`), and TypeScript erases *any* union to `Object` in `design:paramtypes` regardless of
> import style — so the value import alone leaves the parameter just as unresolvable. Built and
> tested that intermediate variant: **still 4/4 red.** The `@Inject()` token is what makes resolution
> work; the value import is what stops the token being `undefined`. Both required, neither sufficient.

**Proposed change — three lines, plus a guard:**

1. Drop `type` from both imports so the classes survive to runtime.
2. Add explicit `@Inject(DeviceDepartureService)` / `@Inject(PlantEligibleFloatingSeService)` to the
   two parameters. Redundant once (1) is done, but it makes the contract independent of import
   style, so a future `import type` tidy-up cannot silently re-break it.
3. Keep `@Optional()`. It is load-bearing: `autoplant-sync.ts` and several tests construct
   `MasterSyncService` by hand with fewer arguments, and the CLI path must keep working.

I considered removing `@Optional()` so a missing provider fails loudly at boot. **Rejected** — it
would break the CLI runner and the hand-constructed tests, which is a larger change than the defect
warrants. The detection requirement is met in §4 instead, which is a better place for it.

**Why not switch the dashboard to read `vehicles.status` directly** (my Q2 diagnostic): it bypasses
`device_departures`, which the #130 ruling pins as lifecycle truth for safety gates. Q2 stays a
diagnostic. We fix the desync, not route around it.

---

## 2. Requirement: it must work on the production path

The whole failure was code that was correct but never ran where it mattered, so a passing unit test
proves nothing here. Proposed evidence, in increasing strength:

1. **A DI-booted e2e test** — build the real `IngestionModule` via `Test.createTestingModule({ imports: [IngestionModule] })`, resolve `MasterSyncService`, and assert the `departures` collaborator
   is non-null. This is the assertion that was missing. Every current test constructs the service by
   hand, which is exactly why CI stayed green.
2. **A behavioural test on the same wiring** — through the DI-resolved service, seed a vehicle that
   flips DEPLOYED→UNDEPLOYED and assert a `device_departures` row appears; flip it back and assert
   `restored_at` is set.
3. **Live proof before any write** — run the existing read-only `autoplant:departure-dryrun`
   (verified read-only: `reconcile({ dryRun: true })`, "writes NOTHING") and show a non-zero plan
   where today it would be empty.
4. **Post-fix run evidence** — `entity_stats.departures` on the next real run showing non-zero
   `inserted`/`updated`, which has read `{0,0,0}` for 33 consecutive runs.

Note the CLI path (`autoplant-sync.ts`) already works and always has. Testing there proves nothing —
that is the trap this bug sat in.

---

## 3. Requirement: no device permanently stuck

I went looking. One real trap, one bounded one, one non-issue.

**Trap A — absent-from-source devices can never be restored. Real, ~1,220 devices *(estimated)*.**
`device-departure.service.ts:152` gates every restore on `input.observed.has(device_id)`. The
`else if` at `:167` only *opens* departures (`active_departure_id === null`). A departed device whose
id is absent from the read therefore matches no branch at all.

It self-heals *if* the device reappears in `mst_vehicle`. But when a device is unfitted and refitted,
its `device_id` can leave the table permanently — the 2026-07-17 investigation documented exactly
this. Those devices are departed forever, and their `vehicles.status` is frozen at a stale value that
downstream code trusts.

*In scope for this fix?* I propose **detection now, remediation separately**: surface a count of
"departed and absent from source for more than N runs" rather than auto-restoring them. Auto-restoring
a device we cannot see would be inference of exactly the kind the absence guard exists to prevent.
I would rather show you 1,220 devices needing a decision than guess at it. **Confidence that the trap
is real: high. Confidence in the 1,220: medium (sample-based).**

**Trap B — the absence guard is all-or-nothing.** If absence exceeds 10% of in-scope devices, the
entire absence path is abandoned for that run (`:181-192`). Correct as a blast limiter, but if the
source degrades persistently the guard trips every run and genuine departures are never recorded —
silently, because it only writes a log line. Covered by the §4 alerting rather than a logic change.

**Non-issue — the insert-scope pin.** A never-deployed device has no FSM row; when it first appears
DEPLOYED it gets created normally. Verified: `NOT_DEPLOYED_NEVER_KNOWN` is a *skip* reason on every
run, not a terminal state.

**Also checked and clean *(exact)*:** all 6,767 open departures have both a `device_states` row and a
live `vehicle_id` link — no orphans.

---

## 4. Requirement: this cannot fail silently again

It ran dead for 17 days with no error, no log line and green CI. Four layers, cheapest first — and
**#130 already established the pattern for precisely this class of silent drift**, so I propose
extending it rather than inventing a mechanism.

1. **A DI resolution test** (§2.1). Catches the exact defect at CI time.
2. **A zero-work warning.** `reconcileDepartures` currently returns silently when the collaborator is
   missing. Make that path log a `logger.warn` naming the missing dependency. A sync that decides not
   to do lifecycle work should say so.
3. **A health-page check** — extend `AutoPlantHealthService.reconciliationHealth()` with a
   `lifecycle` entity. This is the important one, detailed in §5.
4. **Runs-since-last-departure staleness.** `master_sync_runs.entity_stats.departures` has read
   `{0,0,0}` for 33 consecutive successful runs. On a fleet churning ~150 vehicles/day that is
   impossible. Flag when N consecutive SUCCESS runs record zero departures *and* zero restores.
   Threshold as a setting, following `readReconMaxDrift()`'s existing convention.

Layer 4 alone would have caught this within a day. It needs no new data — `entity_stats` has recorded
the evidence all along; nothing read it.

---

## 5. Requirement: the dashboard cannot hide this

**What would have made it visible.** Nothing on the dashboard compares FSM's *derived* lifecycle
state against the *observed* source status it is supposed to track. `Operational` and `Warehouse`
were both wrong, but they still summed to `Mirrored` and every documented identity in
`kpi-definitions.md` §5 continued to hold — the numbers were internally consistent and externally
wrong. Adding more counts would not have helped; the missing thing is a **contradiction check**.

**Proposed smallest addition — one number:**

> **Lifecycle drift** — devices where `vehicles.status` and `is_departed` disagree.
> Today: **6,225** *(exact)*. Correct value: **0**.

Why this one and not another:

- **It is derivable entirely inside Postgres.** No AutoPlant call, so it keeps working when the VPN
  is down — matching `reconciliationHealth()`'s existing degradation posture.
- **It would have gone red on 2026-07-22**, the first sync after run 80, and climbed daily.
- **It has an unambiguous correct value — zero.** No threshold to argue about, unlike a drift
  tolerance. Any non-zero value is a defect by construction, because both fields are written from the
  same source read by the same service.
- **It is a contradiction, not a measurement.** It cannot be explained away as fleet churn, which is
  how a plain count would have been rationalised.

**Placement:** the Integration Health page, as a new entity in the existing
`ReconciliationHealth.entities[]` array — same shape (`entity`/`sourceCount`/`fsmCount`/`drift`),
same `reconciled` roll-up. It is already public for the Ops Explorer reconciliation panel (#217 S3),
so both surfaces get it from one implementation and cannot disagree.

**On your "two screens must not give different answers" rule:** this figure is *not* proposed for the
main KPI strip. Those tiles count devices by lifecycle state; this counts a disagreement *about*
lifecycle state. Putting it beside them would invite subtraction between two things that are not
commensurable. Integration Health is where "is the mirror trustworthy" already lives.

---

## 6. Repo-wide audit for the same defect class

Scanned **747 `.ts` files** across `apps/`, matching constructor parameters whose type came from an
`import type` (or inline `type X`) with no `@Inject()` token.

**Silent variant (`@Optional()` → injected as `undefined`, no error): exactly 2.** Both are the ones
already found, both in `master-sync.service.ts`. **The defect class has not spread.**

**Ten other hits, all verified false positives:**

| Location | Why it is safe |
|---|---|
| `apps/mobile/src/api/client.ts` × 3 | Error-class constructors in the React Native app. No Nest DI. |
| `test/snapshot-*.e2e-spec.ts`, `test/env/book8/*` × 6 | Hand-constructed test doubles, never DI-resolved. |
| `src/ingestion/snapshot-ingestion.worker.ts` | Provided by `useFactory` with an explicit `inject: [...]` array (`ingestion.module.ts:171-178`), so reflection metadata is never consulted. |

**Wider observation, not a defect:** 13 `@Optional()` parameters across 10 backend files. Each is a
place where a wiring mistake degrades silently rather than failing at boot. Only master-sync's two
carry the erasure bug today. If you want this class closed permanently rather than fixed twice, the
durable answer is a lint rule — `@typescript-eslint/consistent-type-imports` with
`disallowTypeAnnotations`, or a targeted rule banning `import type` for any symbol used as a
constructor parameter type. **I recommend this but have not scoped it**; it is a separate change from
the bug fix and I would not bundle it.

**Second casualty of the same two lines:** `PlantEligibleFloatingSeService` (#138 slice 2) is also
null under DI, so the post-sync `plant_eligible_floating_se` MV refresh has never run on the Nest
path. Fixing the import fixes both. **I have not measured that MV's staleness** — flagging it, and it
should be checked before Stage 2 in case the refresh has its own catch-up cost.

---

## 7. Operational safety — the change window

### 7.1 Every downstream effect of a lifecycle transition

Traced from `device-departure.service.ts` and every consumer of `is_departed` / `device_departures`
(9 files). Complete list, harmless ones included.

**On DEPART (device → warehouse):**

| # | Effect | Where | Volume at real numbers |
|---|---|---|---|
| 1 | `device_departures` row created | `openDepartures` | ~4,030 *(est.)* |
| 2 | **All open tickets force-closed** — `CLOSED`, `DEVICE_UNDEPLOYED_CLOSE` | `openDepartures` | **3,709 tickets** *(exact)* |
| 3 | `ticket_events` row per closed ticket | `openDepartures` | 3,709 *(exact)* |
| 4 | `is_inactive` → false, `sla_bucket` → null, `eligible_for_uptime` → false | `DeviceStateService.recompute` | ~4,030 |
| 5 | Dropped from dispatch recommendation | `recommender` hard filter | see #6 |
| 6 | **1,461 of the closed tickets sit on live dispatch batches** | `batch_assignment_tickets`, `removed_at IS NULL` | **1,461** *(exact)* |
| 7 | Excluded from fleet-uptime denominator | eligibility gate | ~4,030 |
| 8 | Dashboard counts shift operational → warehouse | `FLEET_COUNT_COLUMNS` | ~4,030 |
| 9 | No new tickets can be created | `ticket-creation.service.ts:36-37` | ongoing |

**On RESTORE (device → operational):**

| # | Effect | Where | Volume |
|---|---|---|---|
| 10 | `restored_at` / `restored_by_run_id` / `restored_status` stamped | `closeDepartures` | ~1,230 *(est.)* |
| 11 | `audit_logs` row, action `DEVICE_REDEPLOYED` | `closeDepartures` | ~1,230 |
| 12 | Re-enters inactivity, SLA bucketing, uptime eligibility | `recompute` | ~1,230 |
| 13 | **Tickets are NOT reopened** | — | 0 — closure is one-way |
| 14 | **New tickets auto-created for those silent >24 h** | `ticket-creation.service.ts` | **~1,100** *(exact, measured on the 2,197 superset — likely lower after Correction 1)* |
| 15 | Re-enters dispatch recommendation | recommender | ~1,230 |

**Net ticket movement:** −3,709 closed, +~1,100 created, against a current backlog of **16,727 open**
*(exact)*. Backlog lands around **14,100**.

### 7.2 Does anything notify a human? — **No. Verified, and this is the key safety finding.**

- The departure service contains **zero** notification code. (My first grep suggested 6 matches; all
  six were `.push(` — a false positive I checked rather than reported.)
- `ticket-creation.service.ts` contains **no** notification calls — only the `isInactive` /
  `eligibleForUptime` gate.
- The six services that *do* notify — cross-zone escalation, intraday insertion, bulk-unassign,
  day-plan notifier, install notifier, recovery notifier — are **none of them** on the
  departure, restore, or ticket-creation path.
- External delivery is a **seam**. `notifications.module.ts:18` binds
  `NOTIFICATION_CHANNEL_GATEWAY` to `LoggingChannelGateway`, which returns `UNAVAILABLE` for every
  channel and logs. **FCM, APNs, SMS, WhatsApp and SMTP are not wired to real accounts.**

**Conclusion: no driver, dispatcher, customer or field engineer receives a push, SMS or WhatsApp
message from this catch-up.** The thousands-of-notifications incident cannot occur on the current
build. *Confidence: high.* **This must be re-verified if the real gateway adapters land before the
change window** — that single binding is the only thing standing between this catch-up and a mass
send.

**No longer verified by hand.** §7.5 step 4 (`autoplant:window-preflight`) asserts it programmatically
at window time, through the real `AppModule` graph, and exits 1 if the binding has changed. The
assertion checks the gateway's **identity before its behaviour** and refuses to invoke an unrecognised
one: probing an unknown adapter to discover whether it sends would itself be the send this gate exists
to prevent.

### 7.3 The real risk is dispatch, not notifications

**1,461 open tickets on live, non-removed batch assignments will be closed underneath field
engineers.** Nothing in `openDepartures` removes the batch assignment — it closes the ticket and
writes the event. An engineer with a day plan built on those tickets keeps the visit; the ticket
backing it is gone.

Two mitigating facts, one aggravating:
- Mitigating: these are devices genuinely UNDEPLOYED at source (97.2% confirmed by sample), so the
  visits are wasted journeys anyway — this is the #128 finding, "≈ half the live dispatch workload
  is wasted truck rolls."
- Mitigating: no notification fires, so nobody is told mid-shift.
- Aggravating: it happens to 1,461 tickets in one transaction, with no dispatcher-facing summary.

**This is the part I would not run unattended.**

### 7.4 Transaction size

`reconcile` wraps the entire plan in a single `prisma.$transaction` — ~5,260 departure/restore rows,
3,709 ticket updates and 3,709 ticket-event inserts in one transaction. The #128 backfill did
comparable work (5,523 departures, 4,552 ticket cancellations) and completed, so this is **precedented
and I am not proposing to change it**. It should still be run when nothing else is writing.

### 7.5 Recommended catch-up procedure

**My recommendation: this is a change window, not a deploy, and it should not ride a scheduled sync.**

1. **Confirm the scheduler is off** before deploying the fix. If it is on, the first scheduled run
   executes the whole catch-up unattended, at whatever hour it fires. *(INDEX records
   `IN_SCHEDULER_ENABLED=false` as of 2026-07-18 — re-verify, do not assume.)*
2. **Deploy the fix with the scheduler still off.** The fix alone changes no data.
3. **Run `autoplant:departure-dryrun -- --export-standdown <path>.csv`** — read-only, verified.
   Review the plan: departures, restores, absent candidates, guard state, and the
   ticket-cancellation count. **Approval gate — you see real numbers before anything writes.** This is
   the same posture #128 used. The `--export-standdown` flag additionally writes the live-batch
   stand-down list (§7.3) from this same source read; see 3a.
4. **Run `autoplant:window-preflight` immediately before the live pass.** Read-only, exit code is the
   contract: **0 = proceed, 1 = STOP**. It asserts, through the real `AppModule` graph, that
   (a) `NOTIFICATION_CHANNEL_GATEWAY` is still the inert `LoggingChannelGateway` **and** returns
   `UNAVAILABLE` on all four external channels, and (b) `INGESTION_SCHEDULER_ENABLED` is not `"true"`
   — re-verifying step 1 at the moment it matters rather than trusting an earlier reading. This
   replaces the by-hand 2026-08-07 verification, which expires silently the day real adapters land.
   **If it exits 1, the window does not run.**
5. **Run the catch-up as a single manual `autoplant:sync pipeline`**, in a low-activity window —
   early morning IST, before the first shift (Shift A starts 06:00). Not during business hours.
6. **Capture before/after** and reconcile against the dry-run plan.
7. **Only then re-enable the scheduler**, so subsequent runs are small deltas rather than a backlog.

**3a. The stand-down export.** Folded into the dry-run rather than shipped as its own command,
because it needs the departure plan, the plan needs the full ~26k-row source read, and that read is
capped at 90 rows/query by the AutoPlant DBA — a second command would cost a second full read *and*
risk the two disagreeing across ~150 vehicles/day of churn. Deriving both from one read is also what
pins the absence cohort **exactly** instead of the ~300 estimated at Gate 3.

Produced 2026-08-07 (~14:05 IST, read-only): **1,691 live-batch tickets across 234 batches** —
**1,395 SOURCE_STATUS + 296 ABSENT_FROM_READ**, both measured. File:
`audit/autoplant-reconciliation/standdown-live-batches.csv`
(`ticket_id, device_id, vehicle_no, plant, batch_id`, no grouping — §9 as settled). Regenerate it
at window time; the one on disk is a snapshot for review, not the operational list.

**Staging vs all-at-once:** I recommend **all at once**, because the reconcile is set-based and
idempotent — a partial run followed by another leaves the same end state, and there is no natural
batching key that does not risk leaving the fleet half-reconciled across a shift boundary. If you
prefer staging, the honest way is by company (`Nuvista` first — it is 11,886 of 26,446 devices and the
one you have verified by hand), which would need a scope parameter that does not exist today.

**What I would suppress:** nothing, because nothing fires. If the notification adapters land before
the window, the ticket-closure path would need review first.

**One thing I would add before step 4:** capture the 1,461 live-batch ticket ids to a file first, so
dispatch has a list of visits to stand down rather than discovering them missing.

---

## 8. Conventions, and one inconsistency to flag

**Following existing patterns:** health check extends `reconciliationHealth()`'s existing entity
shape; threshold via a `readReconMaxDrift()`-style setting; e2e test in `apps/backend/test/` matching
the `*-e2e-spec.ts` convention; logging via the existing `Logger` with the same message style;
`@Inject` usage matching the four parameters above it in the same constructor.

**Docs to update (all existing formats, no new ones):**
- `.scratch/fsm-platform-v1/INDEX.md` — issue row + one Session-log line (mandatory per CLAUDE.md).
- `docs/SYSTEM-STATE-2026-07.md` §6 — edited in place, before/after counts.
- `docs/kpi-definitions.md` — the lifecycle-drift check, if §5 grows an identity.
- `docs/progress/218-*.md` — TDD completion report, written once.
- New issue file `.scratch/fsm-platform-v1/issues/218-*.md`.

**Inconsistency I am flagging rather than silently resolving:** `MasterSyncService`'s constructor
mixes two DI styles — parameters 3–6 use explicit `@Inject(TOKEN)`, parameters 7–8 rely on type
reflection. That inconsistency is precisely what let the bug hide: the first four are immune to
import-style changes, the last two are not. My proposal makes all six explicit, which changes two
lines of a file whose other four lines already do it that way. I mention it because it means the file
will look *more* uniform after the change, not less — if you would rather I match the
reflection-only style of the last two, say so, but I think that is the wrong direction.

---

## 9. Settled, and what is still open

### Settled by your Stage 1 reply — no further input needed

| Decision | Recorded as |
|---|---|
| **Trap A — detect only** | No auto-restore, no conditional auto-restore for any subset. §0A strengthens this: absent devices are *correctly* departed, so detection is a data-quality readout, not a repair queue. |
| **1,461 affected assignments — flat export, no coordination** | **DELIVERED 2026-08-07** — `--export-standdown` on the dry-run (§7.5 step 3a). Flat file: ticket_id, device_id, vehicle_no, plant, batch_id. No grouping by engineer or day. Exact count is **1,691** (1,395 SOURCE_STATUS + 296 ABSENT_FROM_READ) — the 1,461 was the SOURCE_STATUS cohort alone. On record for when SE ticketing goes live. |
| **Contradiction check ships first, as its own change** | Sequenced ahead of the fix so the before/after is measured independently, not self-reported by the sync. |
| **Assert the notification seam programmatically** | **DELIVERED 2026-08-07** — `npm run autoplant:window-preflight` (§7.5 step 4), asserted through the real `AppModule` graph, exit 1 on breach. Both pass and fail paths exercised. Replaces my "verified once, from memory". |
| **Cover `entity_stats.departures`** | Folded into the same check: N consecutive SUCCESS runs with zero departures *and* zero restores. The signal existed and nothing read it. |
| **Lint rule → follow-up issue, not here** | Raised as a separate issue; the 13 `@Optional()` params across 10 files noted in it. No action in #218. |
| **F2 / F3 out of scope** | Unchanged. Follow-ups only. |

### Revised sequencing

1. **#218a — contradiction check.** Ships alone, enabled, measuring. Reads **5,134** under the revised
   definition (or 6,225 raw). Nothing else changes.
2. **#218b — the DI fix**, with the DI-booted resolution test (§2.1).
3. **Read-only dry-run**, reviewed at the approval gate.
4. **The catch-up window**, per §7.5.
5. **Independent re-measure** of the check: expect **0** under the revised definition, with
   ~1,091 surfaced separately as "departed, missing from source".

### Still open — I need answers on these three

1. **The revised contradiction-check definition (§0A, Consequence 2).** You asked for 6,225 → 0.
   Exact analysis says the raw metric floors at ~1,091 because those mirrors are frozen by design. My
   proposal excludes open `ABSENT_FROM_READ` departures so the metric keeps an unambiguous correct
   value of 0, and surfaces the excluded 1,091 beside it. **This changes what you asked for, so I am
   not assuming it.** The alternative — keep the raw metric and treat ~1,091 as its expected floor —
   is defensible but gives up the "any non-zero is a defect" property that made it worth building.
2. **Check placement** — Integration Health only, or also the Ops Explorer reconciliation panel?
   `reconciliationHealth()` is already public for #217 S3, so both from one implementation is nearly
   free. My inclination is both, since Ops Explorer is where someone investigating would look.
3. **Timing, and the SE team.** Confirm the scheduler is off (INDEX records
   `IN_SCHEDULER_ENABLED=false` as of 2026-07-18 — I will re-verify, not assume), and pick the window.
   Given §0A's ticketing finding, I recommend **telling the SE team the window is happening** even
   though no field coordination is needed: 3,709 tickets flip OPEN→CLOSED and ~1,100 are created in a
   database they appear to be developing against.

### Where my confidence still is not high

- **The `plant_eligible_floating_se` MV staleness — still unmeasured.** It is the second casualty of
  the same two lines and it has never refreshed on the Nest path. I would measure it before Stage 2
  ends rather than discover a second catch-up cost mid-window.
- **F5 — the Excel/source row gap, now 1,251 under authoritative scope.** Unresolved and unrelated to
  this fix, but it is the one number in this whole investigation I have not been able to explain.
- **Dispatch behaviour under a vanished ticket.** You have told me SE ticketing is not in real
  operational use, which removes the field risk. I have traced the code paths and found no cascade,
  but I have not exercised it.

**Retracted since round 1:** the ~1,230 restore estimate (exact: **1,130**), the ~1,220 stuck-device
remediation backlog (withdrawn — those departures are correct), and "post-fix drift = 0"
(**≈1,091** unless the metric is redefined).
