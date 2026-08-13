# 229 — `AutoRecoveryService.runAutoRecovery` has no production caller; 11,042 open tickets are already closable

Status: ready-for-human — implemented 2026-08-10 (§7). **It has now RUN: 200 tickets closed
`CLOSED_AUTO_RECOVERY` at 07:40:37 UTC on 2026-08-10.**

> ### ⚠️ CORRECTION 2026-08-10 — "the code lands inert" was WRONG, and it fired the same day
>
> This file claimed in three places (§5.1 reason 2, "Gating posture", §7) that the pre-check could not
> run because `INGESTION_SCHEDULER_ENABLED` is `false`. **That is true only of the `@Cron` path.** The
> pre-check was wired into *both* `ingestTelemetry()` **and** `runPipeline()` — and `runPipeline()` is
> the Operations-Head **manual HTTP trigger** (`POST /integration/run-pipeline`), which no scheduler
> flag gates. An operator triggered it on 2026-08-10; master sync 117 → snapshot run 153 → the
> pre-check closed **200** tickets, correctly typed with `closed_at` and `audit_logs` rows.
>
> So the deployment gate this issue leaned on **did not exist**. The `AUTO_RECOVERY_MAX_PER_PASS`
> default (200) is the only thing that bounded the event — the cap earned its keep on day one, which
> is exactly the argument for defaulting it rather than making it opt-in.
>
> **The 9,888 estimate is also superseded.** After the fresh ingest only **471** devices are
> open-cycle-but-healthy. Most of the 9,888 were "healthy" only against `device_states` frozen at
> 2026-08-07. **Gate #2 (re-measure after the first real ingest) was correct and is now discharged:
> the true remaining population is ~471, not ~9,888.**
>
> Follow-ups filed: [#230](./230-partial-ingest-manufactures-inactivity.md) (the run that triggered
> this covered only 2,610 of 27,032 devices, and recompute aged the rest into 3,439 phantom tickets)
> and [#231](./231-manual-pipeline-trigger-ungated.md) (the ungated manual path itself).
Type: HITL (wiring it is a step change in every auto-recovery / SE-productivity metric) · Backend
Filed: 2026-08-09
Origin: measured while satisfying the operator's pre-application gate on
[#222](./222-telemetry-staleness.md) — *"tell me the expected closure count for the auto-recovery sweep
before it runs."* Answering that question is what surfaced the fact that it never runs.
Coordinates with: [#222](./222-telemetry-staleness.md) · [#223](./223-ndd-counted-healthy.md) ·
[#228](./228-guard-pattern-remediation.md) (same class: a mechanism that fails toward "fine") ·
[#218](./218-lifecycle-drift-detection.md) (218c must run first — see "Ordering")

> **2026-08-10 — full read-only diagnosis, blast-radius measurement and design added.** Nothing was
> implemented. Every figure below was re-measured against the live `fsm` database on 2026-08-10 and
> reproduces the 2026-08-09 numbers exactly. **Three findings change the design as originally sketched
> in "What to build":** (1) the trigger *was* specified — a `@Cron` in the business-sweep scheduler is
> **not** what the architecture asks for; (2) the sweep as written cannot populate the Fleet Uptime
> auto-recovery metric it exists to feed, because it never sets `tickets.closed_at`; (3) 4,675 of the
> closable tickets sit in **live SE day plans** the sweep does not touch. Sections marked **[MEASURED]**
> are query results; **[ESTIMATE]** is flagged wherever it appears.

## Problem

Auto-recovery is built, documented, tested and unreachable.

`AutoRecoveryService.runAutoRecovery()` (`apps/backend/src/ticketing/auto-recovery.service.ts:27`) is
called from exactly one place in the repository:

```
test/auto-recovery.e2e-spec.ts:99   await service.runAutoRecovery(NOW);
test/auto-recovery.e2e-spec.ts:119  await service.runAutoRecovery(NOW);
```

There is **no `@Cron`, no controller route and no CLI script**. The service is provided and exported by
`ticketing.module.ts`, and `TicketsController` injects it — but only reaches `manualClose`, the
per-ticket ZM endpoint `POST /tickets/:id/auto-recovery-close`. Eleven other business sweeps have
`@Cron` wiring in `business-sweep-scheduler.service.ts`. Auto-recovery is not among them.

**Confirmed at the data, not inferred from the code.** Across 42,955 recorded transitions in
`ticket_events` **[MEASURED 2026-08-10, unchanged from 2026-08-09]**:

| `to_state` | Rows | First | Last |
|---|---:|---|---|
| `OPEN` | 31,162 | 2026-07-09 | 2026-08-07 |
| `CLOSED` | 11,792 | 2026-07-14 | 2026-08-07 |
| `CRITICAL_INSERTION_ACCEPTED` | 1 | 2026-07-09 | 2026-07-09 |
| **`CLOSED_AUTO_RECOVERY`** | **0** | — | — |

The state has never been written. `ticket.status` holds only `OPEN` (12,571) and `CLOSED` (11,792).

---

## 1. What the code actually does (traced 2026-08-10)

### 1.1 `runAutoRecovery(now, thresholds)` — `auto-recovery.service.ts:27-54`

1. `prisma.ticket.findMany({ workType: 'TROUBLESHOOT', status: 'OPEN' }, include: failureCycle)` —
   **the whole open book in one unbounded query**, no zone/plant filter, no limit, no ordering.
2. Skips any ticket with no parent cycle (impossible in practice — `failure_cycle_id` is UNIQUE and a
   raw CHECK makes it NOT NULL for TROUBLESHOOT; **[MEASURED]** all 12,571 have an `OPEN` cycle).
3. Per surviving ticket, **one query per ticket**: every `raw_device_snapshots` row for that device with
   `gps_datetime > cycle.opened_at`. All rows, all columns projected to `gpsDatetime`, no `LIMIT`.
4. `meetsRecoveryCriteria(pings)` — pure, `recovery-criteria.ts:17`: **≥3 pings AND last−first ≥ 15 min**.
5. On pass → `closeAsAutoRecovery(...)`, one `$transaction` **per ticket**.
6. Returns `{ closed: n }`. Nothing else is logged, counted or emitted.

### 1.2 `closeAsAutoRecovery` — `auto-recovery.service.ts:92-126`. Four writes in one transaction:

| Write | Value |
|---|---|
| `tickets` | `status = CLOSED_AUTO_RECOVERY`, `last_state_changed_at = now` |
| `failure_cycles` | `state = VERIFIED`, `closed_at = now` |
| `ticket_events` | one append-only row, `reason_code = NULL` for the sweep (`MANUAL_AUTO_RECOVERY` for the ZM endpoint) |
| `device_states` | `has_open_failure_cycle = false` |

### 1.3 What it does **not** do — all four are defects that surface only once it runs

- **`tickets.closed_at` is never set** (nor `closure_type`, nor `closure_reason`). Every other closure
  writer sets it — `plant-deactivation.service.ts:179`, `device-departure.service.ts:291`,
  `recovery.service.ts:157/348`, `install-lifecycle.service.ts:238`. **This is not cosmetic:**
  `fleet-uptime-aggregation.service.ts:86-91` counts closures with
  `WHERE status IN ('CLOSED','CLOSED_AUTO_RECOVERY') AND closed_at >= monthStart AND closed_at < monthEnd`.
  With `closed_at` NULL, **`autoRecoveryClosures` stays 0 in the cube after the sweep runs** — the exact
  metric PRD story 25 exists to produce. (`VerificationService.finalize` has the same omission for
  SE-repaired `CLOSED`; out of scope here, noted so it is not lost.)
- **No `audit_logs` row.** `VerificationService`, plant-deactivation and device-departure all audit their
  system closures. Auto-recovery writes only the narrower `ticket_events` row.
- **No soft-state resolution.** CONTEXT §Soft States lists *"Ticket closes through valid system rules
  (auto-verification, **auto-recovery**, 409 Conflict, Non-Op close)"* as an explicit resolution event
  for `ON_SITE` / `TROUBLESHOOT_STARTED`. The sweep leaves `soft_states.resolved_at` NULL.
- **No batch/day-plan detachment and no notification.** See §3.4.

### 1.4 Concurrency

No advisory lock, no `version` check on the ticket update, no in-flight guard of its own (the
`BusinessSweepSchedulerService.runGuarded` wrapper it does not have is where every sibling sweep gets
one). A ZM `manualClose` racing the sweep would write the same terminal status twice and emit two
`ticket_events` rows. Low impact, but it is the only concurrency story the sweep has.

Conversely, **an SE-closed ticket is safe**: the scan filters `status: 'OPEN'`, and every manual path
leaves a terminal status, so the sweep cannot re-close it. `TroubleshootSubmissionService:126` returns
the Business-409 for a ticket that left `OPEN`, which is CONTEXT's specified behaviour and works today.

---

## 2. Was it deliberate? — **Partly. And the trigger *was* specified.**

This is the part that changes the design, so it is stated first.

### 2.1 The architecture specifies a trigger, and it is not a cron

Two authority-order documents say the same thing:

- **`docs/workflow/fsm-business-technical-workflow.md:512-519`, §Auto-Recovery Detection** —
  *"**Before creating a new Ticket**, the system checks whether the device's `latest_gps_datetime` has
  advanced since the Failure Cycle was opened."* It sits between the eligibility list and duplicate
  prevention, i.e. **inside the ticket-creation stage**.
- **`docs/backend/fsm-backend-low-level-design.md:615`, §6 Background Workers** — the
  **TicketCreationWorker** row: Trigger *"After device-state recompute"*, failure handling
  *"Duplicate cycle attempt → no-op; **auto-recovery pre-check before create**"*.

There is no worker row for an auto-recovery sweep, and no cadence is specified for one anywhere. The
designed trigger is **a pre-check inside the telemetry pipeline, between device-state recompute and
ticket creation.** The "What to build" sketch below the fold in the original draft of this issue — a
12th `@Cron` alongside the other eleven — is **not what the architecture asks for**, and §5 explains why
that difference is load-bearing rather than pedantic.

### 2.2 The deferral, and where it was lost

- **Issue 08** (`08-auto-recovery-repeat-failure.md:5-9`, done 2026-06-21) records decision (a):
  *"escalation is a daily scan (`RepeatEscalationService.runEscalationScan`, **no cron — scheduling
  deferred like Issue 04**)."* So scheduling was **deliberately deferred**, once, with a note.
- **Issue 108** (`108-business-sweep-scheduler.md`, done 2026-07-07) then swept up the deferrals. Its
  Evidence section is an inventory built from **doc comments** — every entry it lists quotes one
  (*"a 5-min cron wires to it when scheduling lands"*, *"cron deferred"*, *"same posture per its doc
  comment"*). `AutoRecoveryService`'s docstring carries **no scheduling note at all**, so it was
  invisible to that inventory. #108 then closed with *"Ticket creation (`createForInactiveEligible`) is
  intentionally NOT scheduled here"* — and auto-recovery, per the LLD, belongs **with ticket creation**,
  which is precisely the box #108 excluded.
- **Issue 112** (Slice B) later chained `createForInactiveEligible()` into `ingestTelemetry()` and
  `runPipeline()` — and did not chain the auto-recovery pre-check that the LLD puts immediately before it.

**Conclusion: not forgotten once, lost twice** — deferred deliberately by #08, then dropped in the seam
between #108 (which owned sweeps and excluded ticket creation) and #112 (which owned ticket creation and
did not read the LLD's pre-check clause). Nobody made a decision to leave it out.

### 2.3 Implementation drift from CONTEXT — real, and measurably harmless

`CONTEXT.md:117` defines the criterion as *"≥3 pings, ≥15 min span, **≥1h stability**"*.
`recovery-criteria.ts` implements **only the first two**, and says so: *"The fuller three-phase stability
window (≥1h) is shared with — and owned by — GPS verification (Issue 18); this is the minimal shared
predicate."* So the implemented predicate is **weaker than CONTEXT specifies**.

**[MEASURED]** Tightening it to the full CONTEXT criterion changes **nothing**: of the 11,042 tickets
that satisfy ≥3 pings/≥15 min, **11,042 also span ≥ 60 min**. Zero marginal effect. Aligning the code
with CONTEXT is therefore free — and it does **not** address the flapping problem (D3), which is a
different question (see §3.3).

---

## 3. Blast radius — measured against live `fsm`, 2026-08-10

**Standing caveat on the data (`fsm` trust boundary):** device rows and telemetry are a real AutoPlant
mirror; org rows (companies, plants, SEs) are seeded. Ticket and failure-cycle counts were generated by
the real pipeline over real device state, so they are meaningful, but SE-attribution figures hang off
seeded engineers.

### 3.1 The closure set

| | Tickets |
|---|---:|
| Open TROUBLESHOOT tickets (all have an `OPEN` cycle) | **12,571** |
| **Satisfy the sweep predicate today** | **11,042 (87.8%)** |
| — with 0 qualifying pings | 1,396 |
| — with 1–2 pings | 133 |
| — with ≥3 pings but < 15 min span | **0** |
| — also satisfy CONTEXT's ≥1 h stability | **11,042 (all of them)** |

Split of the 11,042 by last-known device health:

| | Tickets |
|---|---:|
| Device `is_inactive = false` at last recompute | **9,888** |
| Device `is_inactive = true` (flapping — pinged after the cycle opened, then went silent) | **1,154** |
| Device departed | **0** |

**Correction to this issue's earlier wording.** These were previously described as *"devices that are
healthy **right now**."* They are not. **[MEASURED]** `device_states.computed_at` is frozen at
**2026-08-07T10:02Z** for all 26,543 rows — the last recompute, because `INGESTION_SCHEDULER_ENABLED`
is `false`. The last snapshot run (`152`, SUCCESS) has `data_as_of = 2026-08-07T09:59Z`. So
"9,888 healthy" means *healthy as of three days ago*; their mean `inactivity_hours` at that moment was
6.2 h. **The split cannot be known until the first real ingest**, which is exactly why gate #2 requires
re-measurement immediately before execution rather than reuse of this figure.

### 3.2 Genuine recovery vs. stale queue

The distinction the operator asked for is answerable, and the answer is that **almost all of it is stale
queue, but of a specific kind**: the devices did genuinely recover — the ping evidence is real — and the
tickets stayed open only because nothing swept them. **[MEASURED]** last qualifying ping, relative to the
2026-08-07 telemetry watermark:

| Last qualifying ping | Tickets |
|---|---:|
| within ~2 days of the watermark | 10,499 |
| 2–7 days | 321 |
| 7–12 days | 139 |
| 12–17 days | 43 |
| 17–22 days | 34 |
| > 22 days | 6 |

95% of the backlog is on devices pinging normally right up to the moment telemetry stopped. This is not a
pile of ambiguous historical cases; it is one month of unswept recoveries.

**A related, harder fact.** **[MEASURED]** all 11,792 tickets ever closed carry
`closure_type = DEVICE_UNDEPLOYED_CLOSE` (10,857) or `OPERATIONS_HEAD_OVERRIDE_CLOSE` (935). There are
**zero troubleshooting submissions and zero verification runs in the database**. No SE has ever worked a
ticket. Consequently the Fleet Uptime cube's **`se_repaired_closures = 7,419` for 2026-07 is entirely
departure and plant-deactivation closures counted as SE repairs** — the aggregation filters on
`status = 'CLOSED'` without regard to `closure_type`. Adjacent to this issue, not caused by it; recorded
here because the same report is the one that will show the auto-recovery step change, and the operator
should not read that column as a baseline.

### 3.3 Ordering, churn, and the REPEAT cascade

**There is an ordering constraint, and the architecture already picked the right order:
recompute → auto-recovery → ticket creation** (`fsm-backend-low-level-design.md:615`).

- **Auto-recovery *after* creation is a no-op by construction.** `TicketCreationService` skips any device
  with `has_open_failure_cycle = true`, which is every one of these devices. Running the sweep after
  creation changes nothing on the same tick and simply delays every closure by one cycle.
- **Auto-recovery *before* creation makes the flapping case visible in a single tick**, which is the
  point. For the 1,154 flappers the sweep closes the cycle `VERIFIED`, clears the flag, and then ticket
  creation — running milliseconds later in the same tick — sees a device that is still inactive and
  eligible, and **opens a brand-new cycle**.

**This churn is live, not hypothetical.** **[MEASURED]** `system_settings.eligibility_mode` is
**`all-deployed`**, not `pgi` — 15,696 devices carry `eligible_for_uptime = true`, and the 31,162 `OPEN`
events prove creation is running. **All 1,154 flapping tickets meet the re-creation predicate today**
(inactive AND eligible AND qualifying pings). Note this corrects the standing "B7 ⇒ 0 tickets created"
framing carried in `SYSTEM-STATE-2026-07.md` §1.2/§3d for the *dev* database as configured.

And re-creation is not neutral. ADR-0021 (`ticket-creation.service.ts:85-91`) flags a new cycle
**`REPEAT`** when a `VERIFIED` cycle closed within the prior 24 h — which the sweep just did. So each
flap produces a REPEAT-flagged cycle, and `RepeatEscalationService` (cron **ON**, `*/15`) escalates any
device reaching **3 REPEAT cycles in 7 days** to `ESCALATED` with a ZM + Warehouse notification. A device
that flaps three times in a week therefore self-escalates. That is arguably correct behaviour for a
genuinely unstable device — but it will arrive as a wave, on tickets nobody worked, and it should be a
decision rather than a discovery. → **D3**.

### 3.4 Surfaces that change the moment the sweep runs — the full list

| # | Surface | Change | Verdict |
|---|---|---|---|
| 1 | ZM/OH ticket queues, Zone Dashboard open counts, Device Detail open-ticket count, entity-mapping export | −11,042. `CLOSED_AUTO_RECOVERY` is already in every terminal-status list (`dashboard.service.ts:311`, `exports/entity-mapping-export.service.ts:17`, `device-departure.service.ts:37`) | **Correct — this is the fix** |
| 2 | **Shared pool** (`tickets_shared_pool_idx`, OPEN+UNASSIGNED) | 6,367 of 6,901 disappear (**92%**) | Correct |
| 3 | **SE day plans** | **4,675** qualifying tickets hold **active** `batch_assignment_tickets` rows across **385 batches** on **292 work_schedules** — of which **399 tickets on 21 `ACTIVE` (today-dated) schedules**. The sweep touches **none** of them: `removed_at` stays NULL, batch status unchanged | **BROKEN — see below** |
| 4 | `ScheduleClosureScheduler` (cron ON) | `CLOSED_AUTO_RECOVERY` ∈ `RESOLVED_TICKET_STATUSES:40-48`, so past-dated schedules flip **`COMPLETED` instead of `PARTIAL`** — retroactively restating how past days went | **Needs a decision (D5)** |
| 5 | **Fleet Uptime cube** | `autoRecoveryClosures` **stays 0** (the `closed_at` bug, §1.3). But `downtime_seconds` *does* move sharply: 11,042 cycles gain a `closed_at`, so open-cycle downtime stops accruing to the window end — a recompute of 2026-08 shows a large uptime jump with no closures to explain it | **BROKEN — worst of the set** |
| 6 | **System Efficiency daily cube** | On the sweep day: `cyclesResolved` **+11,042**, `verifiedCycles` +11,042, `firstTimeFixes` ≈ +11,042 (the filter is `VERIFIED AND NOT repeat AND pause=0` — all true) ⇒ **first-time-fix rate reads ~100% on 11,042 cycles nobody touched**; `autoRecoveries` stays **0** (it is sourced from `verification_runs.outcome`, and the sweep creates no run) ⇒ **`autoRecoveryRatePct` = 0% on the day of 11,042 auto-recoveries**; `agedResolutions` spikes (most cycles opened 2026-07-13); SLA compliance collapses (>48 h) | **BROKEN — reads as a data incident** |
| 7 | **SE productivity** — `me-work-history.service.ts:13` and the mobile Home "COMPLETED" tile | `COMPLETED_STATES = ['CLOSED', 'CLOSED_AUTO_RECOVERY']` — an auto-closed ticket on an SE's schedule for that day **counts as work the SE completed**, contradicting CONTEXT's *"no SE effort is credited"* | **Direct spec conflict (D6)** |
| 8 | Device Detail lifetime trend, auto-vs-SE split | `device-detail.service.ts:117` reads the flag per cycle — correct once #5 is fixed | Correct, downstream of #5 |
| 9 | Next dispatch run | ~1,500 candidates instead of 12,571 | **Correct — this is the fix** |
| 10 | Intraday / cross-zone / component-blocked / vehicle-unavailability | **[MEASURED]** 0 rows on qualifying tickets | No impact |
| 11 | Unresolved soft states on qualifying tickets | **[MEASURED]** 9 | Small, but §1.3 says they should be resolved |
| 12 | Notifications | 265 rows today; the sweep sends none | Gap, see D7 |

**On #3 in detail, because it is the one that produces a wrong screen rather than a wrong number.**
`MeTicketsQueryService:73-96` builds the SE's day plan from `assignedTicketIds` **with no status filter**,
and `workStateFor(status, assigned, inWork)` returns `'PLAN'` for anything that is not
`VERIFICATION_PENDING`. So a closed ticket renders on the SE's app as work to do, indefinitely. Exposure
is **0 today** (mobile is auth-shell only — #54), which is precisely why it must be fixed before #55 lands
rather than after.

### 3.5 Volume and cost — small, and not the problem

**[MEASURED]** against the live database:

- Prefetch of all 12,571 tickets + cycles: **108 ms**.
- Per-ticket ping query: **1.4 ms** mean over 300 samples (the composite
  `raw_device_snapshots (device_id, gps_datetime)` index is used; **no partition pruning happens** — all
  1.65 M rows live in `raw_device_snapshots_default`, because `PARTITION_MAINTENANCE_ENABLED=false` and
  only 11 daily partitions, `2026-07-01`…`07-11`, were ever created).
- Total ping rows read: **398,556** (mean 32/ticket, max 66).
- ⇒ **read phase ≈ 18 s.** Write phase is 11,042 **separate** transactions × 4 statements —
  **[ESTIMATE]** 60–120 s on this hardware, so **~2 minutes end to end**. `ticket_events` grows by
  11,042 rows (42,955 → 53,997, +26%); nothing consumes `ticket_events` in a streaming or triggered way
  (append-only by construction, no DB trigger — `schema.prisma:1812`), so there is nothing downstream to
  overwhelm. `audit_logs` grows by 0 today, and should grow by 11,042 once §1.3 is fixed.

**The cost is not the concern. The concern is that this is 11,042 independent, uncancellable transactions
with no progress reporting, no cap and no resume point.**

### 3.6 A deadline nobody has noticed

`system_settings.telemetry_retention_days = 7`. Retention is inert today only because
`PARTITION_MAINTENANCE_ENABLED=false` has left every ping since 2026-07-12 sitting in the DEFAULT
partition (which is never dropped). **Once partition maintenance is switched on with the ingestion
scheduler — which `SYSTEM-STATE` §2.9 says must happen together — the sweep's evidence window becomes
7 days.** That is fine for a *running* sweep. It is a hard constraint on the *backlog*: any qualifying
ticket whose evidence is not already in DEFAULT would become unclosable. It is not a reason to rush, but
it is a reason not to flip `PARTITION_MAINTENANCE_ENABLED` before this issue is resolved.

---

## 4. Audit of every sweep and scheduled path (answers D4)

**17 `@Cron` handlers exist**, in five homes. All are gated; two master switches are OFF.

| Home | Jobs | Master switch | Live today? |
|---|---|---|---|
| `integration-scheduler.service.ts` | `ingestion-telemetry` (`*/30`), `ingestion-masters` (`0 2 * * *`) | `INGESTION_SCHEDULER_ENABLED` | **NO** (`.env:18` false) |
| `partition-maintenance.service.ts` | `partition-maintenance` (`10 0 * * *`) | `PARTITION_MAINTENANCE_ENABLED` | **NO** (`.env:24` false) |
| `business-sweep-scheduler.service.ts` | 11 jobs (verification, install-verification, intraday-timeout, cross-zone, repeat-escalation, tier-override-expiry, soft-inactive, system-efficiency, fleet-uptime, root-cause, zm-performance) | `BUSINESS_SWEEPS_ENABLED` | **YES** (`.env:38` `"true"`) |
| `dispatch-scheduler.service.ts` | `business-dispatch` (`0 5 * * *`) | `BUSINESS_SWEEPS_ENABLED` | **YES** |
| `schedule-closure-scheduler.service.ts` | `schedule-closure` | `BUSINESS_SWEEPS_ENABLED` | **YES** |
| `plant-eligibility-refresh-scheduler.service.ts` | `plant-eligibility-refresh` | own flag | own flag |

**Sweep-shaped services with no `@Cron` of their own — and where each is actually invoked:**

| Service / method | Reached from | Wired? |
|---|---|---|
| `TicketCreationService.createForInactiveEligible` | `ingestTelemetry` + `runPipeline` (#112) | ✅ |
| `DeviceStateService.recompute` | same | ✅ |
| `RecommenderService.runForZone` | `DispatchRunService` (cron) | ✅ |
| `BatchAssignmentService.dispatchForZone` | same | ✅ |
| `SnapshotRunService.reapStaleRuns` / `MasterSyncRunService.reapStaleRuns` | called first inside each `startRun()` | ✅ |
| `DeviceDepartureService.reconcile` | `MasterSyncService` (explicit `@Inject`, fixed by #218b) + 2 CLI scripts | ✅ |
| `PlantEligibleFloatingSeService.refresh` | own scheduler + master sync | ✅ |
| `ReconciliationService.run` | ops-explorer HTTP, by design | ✅ (on-demand, correct) |
| **`AutoRecoveryService.runAutoRecovery`** | **nothing** | ❌ |

**Answer to D4: auto-recovery is the only unwired sweep in the backend. It is not one of a set — it is
the last one.** #228's five-specimen framing stands, but this issue is a singleton within its own class.

**One correction to D4 as originally written, and it is the same failure mode inverted.** D4 said
`FleetUptimeAggregationService` and `VerificationService` are *"deliberate and documented"* on-demand
services. They are **not on-demand any more** — #108 wired both. Their doc comments still say otherwise,
and so do five others:

```
verification.service.ts:12          "No scheduler here … a BullMQ 5-min cron wires to it when scheduling lands"
install-lifecycle.service.ts:165    "a BullMQ cron wires to it when scheduling lands"
fleet-uptime-aggregation.service.ts:38   "On-demand (no scheduler)"
root-cause-aggregation.service.ts:18     "On-demand (no scheduler)"
zm-performance-aggregation.service.ts:48 "On-demand (no scheduler)"
system-efficiency-aggregation.service.ts:18 "On-demand — a BullMQ daily cron wires to it when scheduling lands"
soft-inactive-count.service.ts:59        "On-demand (no scheduler)"
reports.controller.ts:47,182             "Cron-wired at month-end when scheduling lands"
```

Nine stale claims, all in the same direction: **the docs under-report what runs.** #229's mechanism was
invisible because nothing asserted it *was* wired; these seven are invisible in the mirror image, because
the comment asserts they are *not*. Both are the #228 property — the source of truth for "does this run?"
is a prose comment nobody re-derives. **The wiring assertion this issue needs (AC#2) should therefore
cover all 17 jobs, not just the new one**, and the stale comments should be corrected in the same pass.
(A `@Cron` decorator is evaluated once at class-load, so a registered-job-name assertion is the only
mechanical check that can hold.) This is #228 R4's widened form; it is cheap here and should not wait.

---

## 5. The design

### 5.1 Minimum viable ≠ correct. They are different, and **the MV option is the dangerous one to land.**

**MV — a 12th `@Cron` in `business-sweep-scheduler.service.ts`.** ~15 lines: a
`DEFAULT_AUTO_RECOVERY_CRON`, a config field, an injected `AutoRecoveryService`, and a
`runGuarded('auto-recovery', …)` tick. It buys the in-flight guard, the never-throw wrapper and the
env-overridable cadence for free.

**It should not be used, for one decisive reason.** That scheduler's master switch is
`BUSINESS_SWEEPS_ENABLED`, and **`apps/backend/.env:38` already has it set to `"true"`** — its eleven
siblings are running now. Landing auto-recovery there means **the sweep fires on the next process
restart**, with no separate switch to hold it back. That is the exact opposite of this issue's gating
posture ("land the code disabled"), and it would convert a deliberate operational event into a deploy
side-effect. It could be mitigated with a dedicated `BUSINESS_SWEEP_AUTO_RECOVERY_ENABLED` flag — at
which point it is no longer the minimum, and no longer matches its eleven siblings either.

**Correct — the pre-check inside the telemetry pipeline, exactly where the LLD puts it.**

In `IntegrationSyncService` (`ingestion/autoplant/integration-sync.service.ts`), inject
`AutoRecoveryService` and call it in **both** `ingestTelemetry()` and `runPipeline()`, **between**
`deviceState.recompute()` and `ticketCreation.createForInactiveEligible()`:

```
snapshot ingest → device-state recompute → AUTO-RECOVERY PRE-CHECK → ticket creation
```

Extend `PipelineSummary` / `TelemetryTickResult` with `recovered: { closed: n }` and log it beside the
existing three lines. Five reasons, in order of weight:

1. **It is what the architecture specifies** (`workflow:512`, `LLD:615`). No new decision is required.
2. ~~**Its master switch is `INGESTION_SCHEDULER_ENABLED`, which is `false`.** The code lands inert.~~
   **WRONG — see the correction banner at the top.** `INGESTION_SCHEDULER_ENABLED` gates only the
   `@Cron`. The same service is reached by `runPipeline()`, the ungated OH manual trigger, which fired
   on 2026-08-10 and closed 200 tickets. This reasoning treated "the scheduler is off" as "the code
   cannot execute", and never checked the second caller of the very service it was wiring into — the
   same shape of error as the doc comments in §4 that asserted wiring nobody re-derived. The real
   bound turned out to be `AUTO_RECOVERY_MAX_PER_PASS`, not any switch. → [#231](./231-manual-pipeline-trigger-ungated.md)
3. **Correct ordering, for free** (§3.3): the pre-check runs before creation, so flapping resolves within
   one tick instead of across two, and the churn is visible in one run's summary.
4. **Evidence freshness by construction.** The predicate reads `raw_device_snapshots`. Running on the
   telemetry tick means it evaluates the pings the same pass just wrote. A separate cron on its own
   cadence reads the same table at an arbitrary offset — no benefit, and one more way for two clocks to
   disagree.
5. **It converts silence into a typed zero** (#228 R3). `recovered: { closed: 0 }` in every tick summary
   and log line is the observable that was missing; "it ran and found nothing" stops being
   indistinguishable from "it never ran".

**Cost of correct over MV:** one constructor parameter, two call sites, two result-type fields, and a
module import (`IngestionModule` already imports `TicketingModule` for `TicketCreationService`, so there
is no new dependency edge and no cycle). It is not meaningfully larger than the MV option. **Recommend
the correct option; there is no case for shipping the MV one.**

### 5.2 The four fixes that must ship with the wiring, whichever trigger is chosen

These are not optional polish — without them the sweep produces measurably wrong reports (§3.4).

1. **Set `tickets.closed_at = now`** in `closeAsAutoRecovery`, plus a `closure_type`. There is no
   `AUTO_RECOVERY` value in the `ClosureType` enum today — **either add one (a migration) or leave
   `closure_type` NULL and rely on `status`.** Prefer adding it: `nonStandardClosures()` and every
   closure-type report key on it. Without `closed_at`, PRD story 25 cannot be satisfied at all.
2. **Detach the ticket from its batch.** Set `batch_assignment_tickets.removed_at = now` (with a system
   `removed_by`) in the same transaction, **or** add a resolved-status filter to
   `MeTicketsQueryService`'s assigned branch. The first is truer to the data model (the row means "this
   is in the plan"); the second is smaller. **Recommend the first**, because #175's work-history read
   also derives from those rows.
3. **Write an `audit_logs` row** (`action: 'AUTO_RECOVERY_CLOSED'`, `actorId: 'SYSTEM'`), matching
   `VerificationService.finalize`.
4. **Resolve open soft states** on the closed ticket, per CONTEXT §Soft States.

Additionally, and free: **align `recovery-criteria.ts` with CONTEXT's ≥1 h stability** (§2.3 — measured
zero effect on this backlog, and it removes a live doc/code divergence).

### 5.3 The first run is not the steady state

**Explicitly, as required:**

| | First run | Every subsequent run |
|---|---|---|
| Tickets closed | **~11,042** (to be re-measured) | **[ESTIMATE]** single to low double digits per 30-min tick, once ingestion is live |
| What it is | a **backfill** of one month of unswept recoveries | the mechanism working |
| Open queue | 12,571 → **~1,529** (−88%) in one pass | flat |
| Shared pool | 6,901 → **~534** (−92%) | flat |
| SE day plans | 4,675 tickets detached from 292 schedules | rare |
| `ticket_events` | +11,042 in ~2 min | a handful |
| Report cubes | one-day step change across Fleet Uptime, System Efficiency and every trend that reads them | invisible |
| Reversibility | **none** — no bulk un-close path exists; `failure_cycles` VERIFIED is immutable by design | n/a |

### 5.4 How to gate the backlog

1. **Build the dry-run first, as a CLI script**, following the repo's own precedent for exactly this
   situation: `npm run autoplant:departure-dryrun` (#128) — read-only, never writes, prints the plan and
   optionally exports CSV. Add `npm run autorecovery:dryrun`:
   `runAutoRecovery({ dryRun: true })` returning the qualifying ticket ids with per-ticket evidence
   (ping count, first/last ping, span, device `is_inactive`, assignment state, SE, plant, company, zone),
   plus grouped totals and a CSV export. **A CLI, not an HTTP endpoint**, because the output is 11,042
   rows and because the departure precedent is already understood operationally.
2. **Re-measure the expected count immediately before execution**, after the first real ingest, and write
   it into this issue. The 11,042 figure is measured against telemetry frozen at 2026-08-07 and
   `device_states` frozen at the same instant; it will move.
3. **Stage the first run.** `runAutoRecovery` gains `{ zoneId?, maxClosures? }`. Run **East first**
   (4,937 of 11,042 — 45%; then North 2,306, South 1,434, West 1,258, UNZONED 1,107), verify the queues
   and the day-plan detachment, then the rest. A `maxClosures` cap gives a resume point the current
   all-or-nothing loop does not have.
4. **Recompute the affected cubes deliberately, in the same window**, and annotate the date — Fleet
   Uptime for 2026-08 and System Efficiency for the sweep day. Both are delete+insert idempotent, so this
   is safe; leaving them to their own crons is what turns a fix into an unexplained anomaly three weeks
   later.

### 5.5 Ordering in the deployment sequence

**#218c must run before the first auto-recovery run.** The departure pass closes tickets on devices that
have left the fleet with `closure_type = DEVICE_UNDEPLOYED_CLOSE` — a *truer* closure type than
`CLOSED_AUTO_RECOVERY` for a device that was removed from a vehicle and is pinging from a warehouse
shelf. **[MEASURED]** 0 of the current 11,042 are on already-departed devices, but #218c is a fresh
reconcile against live AutoPlant and will find departures that occurred since 2026-08-07; running
auto-recovery first would mis-type those closures **irreversibly**. Magnitude is unmeasurable from here
(it needs the AutoPlant read) — **[ESTIMATE: direction certain, size unknown]**.

Full sequence:

```
#218c departure catch-up (operator-gated, already)
  → first real ingest / master sync            (INGESTION_SCHEDULER_ENABLED on)
  → re-measure the auto-recovery count → write it into this issue
  → autorecovery:dryrun, reviewed
  → staged execution, zone by zone, in an agreed window
  → deliberate cube recompute + annotation
  → only then: PARTITION_MAINTENANCE_ENABLED (§3.6)
```

---

## Gating posture — OPERATOR-GATED. Turning the sweep on is an event, not a deploy.

**Recorded 2026-08-10 at the operator's instruction, before any implementation.** This section governs
*how* the switch is thrown, not *what* is built.

Wiring this sweep is a **single write action that closes ~11,042 tickets against a 12,571-ticket open
book — 88% of it, in one pass.** That is not a deployment outcome, it is an operational event with a
before and an after that every downstream report will show. It carries the same posture as #128/#218's
departure catch-up and is gated the same way:

| Requirement | Why it is not optional |
|---|---|
| **1. A read-only dry-run first**, reporting the exact ticket ids it would close, grouped by company/plant/zone, with the ping evidence that qualifies each. | The criterion is evaluated per ticket against `raw_device_snapshots`; nobody has ever seen its output on real data, because it has never run. A count is not evidence — #222's `MAX()` trap and this issue's own `+5`-vs-`11,042` finding are both cases where the aggregate hid what the rows said. |
| **2. An expected closure count agreed in advance and written into this issue**, exactly as the operator required for #222. | Stated verbatim there: *"I want that number in the issue before the sweep runs, not after someone asks why SE productivity spiked."* The same reasoning applies with ~25× the blast radius. The figure must be re-measured immediately before execution, not reused from 2026-08-09 — **and §3.1 now gives a second, harder reason: the health split it rests on is frozen at 2026-08-07.** |
| **3. An agreed execution window.** | `CLOSED_AUTO_RECOVERY` is deliberately distinct from SE-repaired `CLOSED`, so SE productivity is protected in *principle* — **but §3.4 #7 shows the mobile work-history read credits it to the SE anyway**, and auto-recovery rate, monthly Fleet Uptime closure splits, open-queue counts and every trend chart that reads them step-change on the day. A window makes that a dated, explainable event instead of an anomaly someone finds later. |
| **4. A decision on the backlog vs. the steady state (D1).** | One pass closing 11,042 and a tick closing a handful are different products. §5.3 states the difference explicitly. |

**Not gated, and worth separating:** *writing* the wiring, the four §5.2 fixes and the wiring assertion is
ordinary work and needs no gate — it is only *enabling* it against production data that does.
~~With the §5.1 recommended trigger, the code lands behind `INGESTION_SCHEDULER_ENABLED=false` and is
inert by default.~~ **This was the load-bearing mistake of this issue** (correction banner, top): the
recommended trigger has *two* callers and only one of them is behind that flag. Landing the wiring was
therefore NOT separable from enabling it — deploying the code put a live 200-closure event one OH
button-press away, and that press happened the same day. The lesson is not "gate harder" but that a
gating claim must name the **callers** it covers, not the flag it hopes covers them.

**Do not treat the 12,571 baseline as open work.** It is the unswept queue this issue is about;
9,888 of those tickets are on devices that were healthy at the last recompute. Real open work is nearer
1,500. Every rate quoted against 12,571 across #222 and #223 is diluted ~8× and is flagged in place.

## What to build

1. **Wire the sweep as a pre-check in `IntegrationSyncService`** (§5.1), between device-state recompute
   and ticket creation, in both `ingestTelemetry()` and `runPipeline()`; surface `recovered.closed` in
   the pipeline summary and the log line. *(Supersedes the original "a 12th `@Cron`" sketch — see §2.1
   and §5.1 for why.)*
2. **Ship the four correctness fixes** of §5.2 in the same slice: `closed_at` (+ closure type),
   batch detachment, audit row, soft-state resolution. Plus the free CONTEXT alignment (§2.3).
3. **Make the wiring assertable — for all 17 jobs, not one** (§4): a spec that boots the real `AppModule`
   and asserts the registered cron-job name set, plus an assertion that the telemetry tick's result type
   carries a `recovered` field. Correct the nine stale "no scheduler" doc comments in the same pass.
   Shape: `autoplant:window-preflight` / the #218 binding assertion. A comment is not a guard (#228).
4. **Build `npm run autorecovery:dryrun`** (§5.4.1), read-only, CSV-exporting, on the
   `autoplant:departure-dryrun` pattern.
5. **Add `{ zoneId?, maxClosures?, dryRun? }` to `runAutoRecovery`** so the first pass can be staged and
   resumed (§5.4.3).
6. **Decide and record D1–D7 before the first sweep executes.**

---

## 7. What was implemented — 2026-08-10

All six "What to build" items landed. ~~The code is inert by default.~~ **It was not** — see the
correction banner at the top: the OH manual trigger `runPipeline()` is ungated, and it ran the
pre-check on 2026-08-10, closing 200 tickets. Every gate in "Gating posture" still applies to
enabling the *scheduled* path, but the manual path was never behind one.

### 7.1 The wiring (§5.1 recommended option)

`AutoRecoveryService.runAutoRecovery` is called from `IntegrationSyncService` in **both**
`ingestTelemetry()` and `runPipeline()`, between `deviceState.recompute()` and
`ticketCreation.createForInactiveEligible()` — the position `workflow:512` and `LLD:615` specify.
Both entry points share one private `runAutoRecoveryStage()` so they cannot drift apart again, which
is exactly how this stage went missing (#112 chained creation into both paths and the pre-check into
neither). `recovered` joins `PipelineSummary` / `TelemetryTickResult`, and the log line prints
`closed/scanned` plus a deferral note — a run that closed 200 of 9,000 and one that closed 200 of 200
must not print the same thing. **The MV `@Cron` was not built**, for the reason in §5.1: `.env:38`
already has `BUSINESS_SWEEPS_ENABLED="true"`, so it would have fired on the next restart.

### 7.2 The healthy-device rule (D3) — the substantive design change

`device: { state: { isInactive: false } }` on the scan. **Closure set 11,042 → 9,888.** See D3 below
for why this replaced the proposed first-run/steady-state mode switch.

### 7.3 The four §5.2 fixes, and the bound

| Fix | What it prevents |
|---|---|
| `closed_at` + new `ClosureType.AUTO_RECOVERY_CLOSE` (migration `20260810120000`, applied to `fsm` + `fsm_test`) | `fleet_uptime` counts closures by `closed_at`; without it `autoRecoveryClosures` reads **0** on the day 9,888 tickets close — PRD story 25's own metric |
| `audit_logs` row (`AUTO_RECOVERY_CLOSED`, actor `SYSTEM`, ping evidence in `metadata`) | The only system closure with no audit trail; every sibling writer has one |
| Soft-state resolution (`resolvedBy: 'SYSTEM'`, `resolutionReason: 'AUTO_RECOVERY'`) | CONTEXT §Soft States names auto-recovery an explicit resolution event; 9 rows were dangling |
| Batch detachment (`batch_assignment_tickets.removed_at`) | A closed ticket renders on the SE day plan **indefinitely** (`MeTicketsQueryService` has no status filter); 4,675 tickets affected |
| **`AUTO_RECOVERY_MAX_PER_PASS`, default 200** (D9) | An uncapped first pass is 9,888 uncancellable transactions arriving as a deploy side-effect. Oldest cycle first ⇒ a capped pass is a deterministic prefix and the next resumes exactly where it stopped. `unlimited` disables. Added to #182's env allowlist so a developer's `.env` cannot leak an uncapped run into the test suite. |

Plus the free CONTEXT alignment (§2.3): `recovery-criteria.ts` now implements the ≥1 h stability
clause. Its docstring had deferred that to *"GPS verification (Issue 18), which owns it"* — a claim
that was itself stale, since `meetsRecoveryCriteria` has exactly one caller. Measured zero effect on
the backlog, as predicted.

### 7.4 Dry-run — built and run

`npm run autorecovery:dryrun` (`--zone` / `--max` / `--export <csv>`), read-only, on the
`autoplant:departure-dryrun` pattern. **Executed against live `fsm` 2026-08-10:**

| | |
|---|---:|
| Candidates scanned (open + device healthy now) | 9,938 |
| **Would close as `CLOSED_AUTO_RECOVERY`** | **9,888** |
| By zone | 3: 4,522 (46%) · 1: 2,132 · 2: 1,318 · 4: 1,006 · 5: 910 |
| Ping count (min / p50 / max) | 3 / 43 / 66 |
| Recovery span (min / p50 / max) | 11 h / ~23 d / ~28 d |
| Failure cycles span | 2026-07-09 … 2026-08-06 |

The 9,888 reproduces §3.1's "healthy at last recompute" figure exactly — but it is still measured
against `device_states` frozen at **2026-08-07**, so gate #2 (re-measure after the first real ingest)
is **not** discharged by this run.

### 7.5 AC-2 widened (§4)

`test/scheduler-wiring.e2e-spec.ts` boots the real `AppModule` and asserts (a) the **exact** set of
17 registered cron-job names — `toEqual`, not `toContain`, so a job that silently stops registering
fails — and (b) that the pre-check is reached, by spying on the container's own `AutoRecoveryService`
while driving the container's own `IntegrationSyncService`. The stale "no scheduler / when scheduling
lands" comments were corrected: **ten**, not the nine §4 listed — `integration-sync.controller.ts`
carried a tenth ("first light — no scheduler yet"). Each now names the job that drives it, so the
claim is checkable against the spec rather than being prose nobody re-derives.

### 7.6 Not done here

- The first real ingest, the re-measure, and execution — all still operator-gated.
- **D1, D5, D7 remain open** (staging, `PARTIAL`→`COMPLETED` restatement, SE notification).
- `VerificationService.finalize`'s identical `closed_at` omission for SE-repaired `CLOSED` (§1.3) —
  out of scope, still unfixed, still worth its own issue.
- The `se_repaired_closures = 7,419` mis-attribution (§3.2) — adjacent, untouched.

## Open questions / decisions needed

**Product decisions (operator's call):**

- **D1. Does the first sweep close ~11,042 in one pass, or staged?** §5.3 states what each looks like.
  Recommendation: staged by zone, East first.
- **~~D3.~~ ANSWERED by the design, not by a mode switch — option (b), permanently.** The scan now
  carries `device_states.is_inactive = false`. The recommendation above was "(b) for the first run,
  (a) as the steady state"; implementing it revealed the two-mode split was unnecessary and wrong.
  **Auto-recovery is a claim about *now*** — this device is back — not about whether some window in
  the past contained three pings. A device that is inactive at the recompute which just ran has not
  come back, in a backfill or in steady state. It is also arguably CONTEXT's ≥1 h stability clause
  read correctly: liveness, not ping arithmetic. **Measured: 11,042 → 9,888**, excluding exactly the
  1,154 flappers, confirmed by `autorecovery:dryrun`. The rule is only meaningful *at this position in
  the pipeline*, where recompute has just rewritten the column — a standalone cron would read it up to
  a full cadence stale, which is the second reason the LLD's placement is load-bearing rather than
  stylistic. Creation (`is_inactive = true`) and recovery (`is_inactive = false`) are now exact
  complements: no device can be touched by both stages on one pass.
- **D5. `ScheduleClosureScheduler` will flip past-dated schedules from `PARTIAL` to `COMPLETED`**
  (§3.4 #4) — is retroactively restating how past days went acceptable, or should closure be evaluated
  as of the schedule's own date?
- **~~D6.~~ ANSWERED by the operator 2026-08-10 — CONTEXT wins: no SE effort is credited.**
  `CLOSED_AUTO_RECOVERY` no longer counts toward SE completed work. Removed from **three** shared
  definitions, not the two this issue recorded: `me-work-history.service.ts:13`,
  `apps/mobile/src/home/homeKpi.ts` **and** `apps/mobile/src/home/plantSummary.ts` — the third carries
  the same "one definition of done for the whole screen" comment and would have silently contradicted
  the other two. The 2026-08-04 #175 unification was right about the *shape* (one definition shared
  across the screen) and wrong about this member. **No displayed figure was ever wrong**, because no
  `CLOSED_AUTO_RECOVERY` row had ever been written — the contradiction was latent, and wiring the
  mechanism is what would have made it visible.
- **D7. Should the assigned SE be notified** when a ticket is removed from their plan by the sweep?

**Engineering decisions (no operator input needed):**

- **D2. Cadence** — settled by §5.1: the telemetry tick (`*/30`). No separate cron, no separate cadence.
- **D8.** Add an `AUTO_RECOVERY` value to the `ClosureType` enum (migration) or leave `closure_type` NULL?
  Recommend adding it.
- **D9.** Batch the 11,042 closures into chunked transactions rather than 11,042 individual ones, for a
  resume point? Recommend yes, with `maxClosures`.
- **~~D4.~~ Answered** (§4): auto-recovery is the **only** unwired sweep. The related finding — nine
  stale "no scheduler" doc comments on services that *are* wired — is folded into item 3 above.

## Acceptance criteria

- ✅ `runAutoRecovery` has a production caller **at the LLD-specified position** (after recompute, before
  ticket creation) and a test asserting the binding on the real `AppModule`
  (`scheduler-wiring.e2e-spec.ts`).
- ✅ The registered cron-job-name assertion covers all 17 jobs; the stale "no scheduler" comments are
  corrected (**ten**, not nine — §7.5).
- ✅ `tickets.closed_at` is set on auto-recovery closure — asserted by `auto-recovery.e2e-spec.ts`.
  ⚠️ **The Fleet-Uptime-recompute-shows-non-zero half is NOT separately asserted**: the cube spec has
  no auto-recovery fixture, and adding one is a `fleet-uptime-aggregation.e2e-spec.ts` change this
  slice did not make. The `closed_at` write it depends on *is* pinned, so the remaining gap is the
  end-to-end join, not the fix.
- ✅ A closed ticket is detached from its batch — asserted by `auto-recovery.e2e-spec.ts`.
  ⚠️ The "no longer appears on the SE day-plan read" half is covered *by construction* (the read
  filters `removedAt: null`) but is not asserted through `MeTicketsQueryService` itself.
- ✅ `autorecovery:dryrun` exists, is read-only, and has been run (§7.4).
- ⚠️ **D3 and D6 answered and recorded. D1, D5, D7 still open** — all three are execution-shaped, so
  they block *enabling*, not this slice.
- ⛔ The expected first-run closure count re-measured **after the first real ingest** — **not
  discharged.** §7.4's 9,888 is measured against `device_states` frozen at 2026-08-07 and must be
  re-run once ingestion has been on for one pass.
- `docs/SYSTEM-STATE-2026-07.md` stops describing auto-recovery as an operating mechanism while it does
  not operate, and §1.2/§3d's "B7 ⇒ 0 tickets created" framing is corrected for the current
  `eligibility_mode = 'all-deployed'` setting (§3.3); corrected in place per CLAUDE.md.

## UI surfaces

n/a as a new surface — but **not** "no UI impact": §3.4 lists twelve surfaces whose numbers move, and two
(the SE day plan, the System Efficiency report) that display something wrong until §5.2 lands.

## Reference

n/a

## Blocked by

Nothing technically. **Ordering constraint, not a block:** #218c must run first (§5.5), and
`PARTITION_MAINTENANCE_ENABLED` must not be flipped before this resolves (§3.6).
**Deliberately NOT bundled into the #222 + #223 slice** — see #222's "Expected auto-recovery closure
count" section: an 11,042-closure event has nothing to do with the timestamp fix (which moves the number
by 5) and must not be attributed to it.
