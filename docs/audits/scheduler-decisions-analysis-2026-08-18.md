# Scheduler Decisions — Architecture & Code Analysis

**Investigation only. No code, schema, migration, scheduler behaviour, production data, or AutoPlant
was modified.**

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Analysing** | Decision 1 (non-blocking preview) · Decision 2 (no vehicle-location rule) · Special Ticket · Vehicle Return Date |
| **Method** | Fresh trace of `apps/backend/src`, `apps/admin/src`, `apps/mobile/src`, FSM Postgres |
| **Prior reports** | Treated as **not authoritative** and re-verified from source |

---

## 1. Understanding of My Decisions

### Decision 1 — Non-blocking preview

Admin can see tomorrow's plan before it runs, and may **change** it or **hold** parts of it. If the
admin does nothing, the 05:00 scheduler runs anyway. Admin action is optional; absence of action is
not a blocker.

### Decision 2 — Vehicle-location confidence

We do **not** trust vehicle-location data enough to gate work on it. Therefore **no rule may
automatically hold, defer, reject, or deprioritise a ticket because the system believes the vehicle is
not at the plant.** Vehicle presence is not an input to scheduling.

### Special Ticket

When a ticket is **assigned to an SE repeatedly but still never troubleshot**, the system should
identify it as **Special**. The purpose is *identification* — surfacing devices that cycle through
assignment without ever being worked.

### Vehicle Return Date

When an SE handles a ticket and enters an expected **vehicle return date**, the ticket waits, and on
that date it becomes a **priority for scheduling**.

```text
Vehicle not available → SE enters return date = 25 Aug → ticket pending → 25 Aug → ticket gets priority
```

### What I am explicitly NOT doing in this report

Per your constraints: no vehicle-presence rule, no capacity-model change, no fairness/starvation
mechanism, no route optimisation. Where I previously recommended those, **they are withdrawn.** I
analyse only the four items above.

### One thing I want to flag as unclear rather than fill in myself

**"Priority" is not defined in your decision, and the current scheduler has no concept that matches
it.** There is a canonical sort (Tier → Bucket → Rank → Age → DeviceId) and nothing else. "Gets
priority on the return date" could mean at least five different things, and they produce materially
different day plans. I set the options out in §8 and leave the choice to you.

---

## 2. Current System Behaviour

Traced from source. Every claim below is from code or a live query, not documentation.

### 2.1 Ticket creation

`TicketCreationService.createForInactiveEligible()` — six predicates, none spatial:

```text
inactivityHours >= se_assignment_threshold_hours   (live value: 48)
eligibleForUptime = true                           (eligibility_mode = all-deployed)
hasOpenFailureCycle = false
device has no active row in device_departures
plantId not null and not deactivated
companyId not null
```

Creates `failure_cycle` (OPEN) + `ticket` (TROUBLESHOOT, OPEN, **UNASSIGNED**) + `ticket_event` in one
transaction.

### 2.2 Assignment

`DispatchRunService.runForActiveZones()` on cron `dispatch_cron = "0 5 * * *"` (Asia/Kolkata), or via
`POST /api/schedules/dispatch-run`.

Per zone: `RecommenderService.runForZone()` selects tickets that are

```text
workType = TROUBLESHOOT, status = OPEN, assignmentState = UNASSIGNED
AND notDeferredOn(today)                  -- deferral.ts
AND plant not deactivated, in this zone
AND device has no active departure
AND (inactivityHours >= threshold OR inactivityHours IS NULL OR no state row)
```

…canonically sorts them, picks an SE by **strict coverage precedence** (Dedicated → Multi-Plant →
Floating; SE Planner is a soft tiebreak among already-eligible candidates), applies five hard filters,
and writes a `recommendations` row with `status = SUGGESTED`.

`BatchAssignmentService.dispatchForZone()` then, under a per-zone advisory lock, groups
SUGGESTED recs `se_id → plant_id → ticket_ids` and writes `work_schedules` → `plant_batch_assignments`
(with `stop_sequence`) → `batch_assignment_tickets`, flips the ticket to **FORMALLY_ASSIGNED** and
clears `deferredUntil`, then flips all recs `SUGGESTED → DISPATCHED`.

### 2.3 SE visit → troubleshoot outcome

| Stage | Table | Rows in this DB |
|---|---|---|
| SE opens / arrives / starts | `soft_states` (`VIEWED`, `ON_SITE`, `TROUBLESHOOT_STARTED`) | **17** |
| SE submits the form | `troubleshooting_submissions` | **0** |
| Ticket transition | `ticket_events` | OPEN 35,510 · CLOSED 15,066 · CLOSED_AUTO_RECOVERY 2,000 · CRITICAL_INSERTION_ACCEPTED 1 |
| Vehicle absent | `vehicle_unavailability_reports` | **0** |

On a real submit, `TroubleshootSubmissionService` moves ticket `OPEN → VERIFICATION_PENDING` and cycle
`OPEN → SUBMITTED`, resolves the SE's soft states, and writes an audit + lifecycle event — all in one
transaction, idempotent on `(se_id, client_submission_id)`.

**In this environment the field loop has never been exercised.** There is not one `SUBMITTED` event.

### 2.4 Reassignment — and the gap that matters most

This is the central finding of the analysis.

`ScheduleClosureScheduler` (cron `0 4 * * *`, gated on `BUSINESS_SWEEPS_ENABLED`) closes past-dated
schedules: `PARTIAL` if any still-assigned ticket is unresolved, else `COMPLETED`.

**It does not unassign anything.** It changes `work_schedules.status` and nothing else. The
`batch_assignment_tickets` row keeps `removed_at = NULL`; the ticket keeps
`assignmentState = FORMALLY_ASSIGNED`.

Because the recommender only selects `UNASSIGNED` tickets, the consequence is:

> **A ticket that is dispatched and not worked is never re-dispatched. It is stranded, permanently,
> on a closed PARTIAL day plan.**

Measured:

| Measure | Count |
|---|---:|
| Live batch rows (`removed_at IS NULL`) on **PARTIAL** schedules | **7,590** |
| …on COMPLETED schedules | 384 |
| …on ACTIVE schedules | 319 |
| Tickets OPEN + FORMALLY_ASSIGNED | 4,983 |
| Tickets with `deferred_until` set | **0** |

The only thing that returns a ticket to `UNASSIGNED` today is a **human**:

| Audit action | Operations |
|---|---:|
| `BULK_UNASSIGN_ZONE` (OH rebalance, #179) | **20** |
| `BATCH_OVERRIDE_DEFER_TICKET` | 2 |
| `BATCH_OVERRIDE_REASSIGN` | 2 |

Which is exactly what the assignment-count distribution shows:

| Times a ticket has been assigned | Tickets |
|---:|---:|
| 1 | 6,486 |
| 2 | 4,849 |
| 3+ | **0** |

**No ticket has ever been assigned three times.** The 4,849 double-assignments are the footprint of 20
bulk-unassign operations, not of a system loop.

### 2.5 Vehicle unavailability → return date

`apps/mobile/src/tickets/vehicle-unavailability/VehicleUnavailabilityFormScreen.tsx` exists and is
wired. `VehicleUnavailabilityService.fileReport()` does exactly three things:

1. Creates a `vehicle_unavailability_reports` row carrying `expectedFrom`, `expectedTo`, reason code,
   transporter contact, and optional SE GPS.
2. Pauses the **primary** SLA on the failure cycle (`slaPauseReason = VEHICLE_UNAVAILABLE`), if not
   already paused. The **secondary** SLA never pauses.
3. Touches `ticket.lastStateChangedAt`.

**It does not touch `deferredUntil`, `assignmentState`, or the batch.** The ticket stays
`FORMALLY_ASSIGNED` on the same batch, and `expectedFrom` is never read by any scheduling code.

SLA resume is **manual only** — `resumeSla()` requires a ZM action, which also resolves the report.
Nothing resumes the SLA when the expected return date arrives.

### 2.6 Next scheduler run

Reads `UNASSIGNED` + `notDeferredOn(today)`. A ticket left `FORMALLY_ASSIGNED` is invisible to it
forever.

---

## 3. Decision 1 — Non-blocking Preview

### 3.1 What already exists — a near-exact precedent

`BulkUnassignService` (#179) already implements the pattern you are describing, end to end:

```text
POST /api/schedules/bulk-unassign  (no token)  → PreviewResult
     { operationId, previewToken, targetDate, zones: [{ zoneId, zoneName, counts }] }

     counts = { eligible, onSite, componentBlocked,
                closedExcluded, installRecoveryExcluded, deferredExcluded }

POST /api/schedules/bulk-unassign  (with token) → executes, or:
     TOKEN_REQUIRED | TOKEN_INVALID | TOKEN_STALE { freshPreview }
```

- The token is **HMAC-SHA256 signed** (reusing `JWT_ACCESS_SECRET`), with a **10-minute TTL** and a
  `countsByZone` snapshot baked into the payload.
- `TOKEN_STALE` means *the world moved since you looked* — and it returns a **fresh preview** rather
  than executing on a stale picture.
- `GET /api/schedules/bulk-unassign/history` reads back every operation from `audit_logs`.
- The admin UI exists: `apps/admin/src/pages/admin/BulkUnassignPage.tsx`.

This is the strongest possible evidence that Decision 1 fits the architecture: **the same team has
already solved "show the admin a projection, let them act, refuse to act on a stale one" once.**

Also existing and directly reusable:

| Capability | Where | Status |
|---|---|---|
| Post-run transparency (what the run decided and why) | `DispatchTransparencyQueryService` + `apps/admin/src/pages/dispatch/*` | Built — but **after** the run |
| Per-ticket decision trace | `dispatch_decision_traces` | Built |
| Hold primitive | `tickets.deferred_until` + `notDeferredOn()` | Built, **0 rows — unused** |
| Manual run trigger | `POST /api/schedules/dispatch-run` | Built |
| Cron owned by settings, not env | `system_settings.dispatch_cron` | Built |
| In-flight guard | `GET /api/schedules/dispatch-run/in-flight` | Built |

### 3.2 What would need to change

**1. The recommender has no dry-run mode.** `runForZone()` writes `recommendations` rows and
`dispatch_decision_traces` unconditionally, and clears orphaned SUGGESTED recs as a side effect. There
is no way to ask "what would you decide?" without mutating.

A preview therefore needs one of:
- a `DRY_RUN` flag threaded through `runForZone` that returns the decision list and persists nothing; or
- a separate read-only projection service that re-implements the selection — **not recommended**, this
  is exactly the six-copies-of-a-predicate failure mode that caused #153.

The first option is the one consistent with how this codebase already handles seams.

**2. "Change" needs its scope defined.** Your decision says admin can *change* the plan. The existing
`OverrideService` covers `REMOVE_TICKET`, `DEFER_TICKET`, `REORDER`, `SWAP_SE`, `REASSIGN`,
`SPLIT_BATCH` — but every one of them operates on a `plant_batch_assignment` that **does not exist
yet** at preview time. A pre-run change has nothing to attach to.

The only pre-run change the current data model can express **without new tables** is a hold
(`tickets.deferred_until`). Anything richer — "assign this plant to SE-4 tomorrow" — needs either a new
pre-assignment override table or a `se_planner` row (which is a soft bias, not binding).

**This is a gap in the design as stated, not something I should fill.** See §15.

**3. Preview date vs run date.** `runForZone` uses `now` throughout: `istDate(now)` for deferral and
planner, `committedDayLoad(istDate(now))` for capacity, `currentStatus(seId, now)` for availability. A
preview for *tomorrow* run *today* would evaluate today's capacity and today's availability. To preview
tomorrow honestly, those three reads need a target-date parameter. The data model supports it —
`se_availability` has `windowStart`/`windowEnd`, `se_planner` has `planned_date` — only the call sites
pass `now`.

### 3.3 Can admin changes safely coexist with the 05:00 run?

**Yes, if holds are expressed as `deferred_until`.** Reasoning from the code:

- A hold is a write to `tickets.deferred_until`. The 05:00 run reads it via `notDeferredOn(istDate(now))`,
  which is spread into the recommender, Shared Pool, intraday and cross-zone reads from **one shared
  definition**. No new coordination is needed.
- There is no lock contention: the admin writes to `tickets`, the run takes a per-zone advisory lock
  around `work_schedules`/batches.
- If the admin does nothing, `deferred_until` stays NULL and the run proceeds — which is precisely
  Decision 1.

**One real interaction to be aware of:** `batch-assignment.service.ts:182` clears `deferredUntil` when
a ticket is dispatched. That is correct (the deferral has done its job), but it means a hold is
**single-use** — it survives exactly until the ticket is next dispatched, then it is gone. For a hold
that means "not tomorrow", that is the right behaviour.

**The honest limitation:** a preview generated at 18:00 is a projection of a world that changes before
05:00. Between the two, ingestion runs, `DeviceStateService.recompute()` ages devices, ticket creation
opens new tickets, and `AutoRecoveryService` closes recovered ones. The preview will not match the run
exactly, and no amount of engineering makes it. The bulk-unassign `TOKEN_STALE` design is this
codebase's existing, correct answer to that problem: bind the preview to a snapshot, and refuse to
pretend it is still current.

### 3.4 Do manual runs affect this?

`POST /api/schedules/dispatch-run` runs the identical path with `trigger = MANUAL`. It is safe to
re-run:

- per-zone `pg_try_advisory_xact_lock`; a contended zone records `LOCK_CONTENDED` and is skipped
- `SUGGESTED → DISPATCHED` consumption means a second invocation cannot re-dispatch the same recs
- `batch_assignment_tickets_one_active_per_ticket` partial unique is the durable backstop
- `GET /dispatch-run/in-flight` returns a `CONFLICT` with who holds it

So a manual run after an admin edits holds simply picks up the holds. **No change needed.**

---

## 4. Decision 2 — Do Not Trust Vehicle Location

### 4.1 Can the application operate without it? Yes — because it already does.

Verified against source, not assumed:

| Would-be location input | Current state |
|---|---|
| `plants.location` (PostGIS geometry) | Column exists, **NULL for all 933 rows** |
| `device_states` position columns | **None** — no lat/lon on the table |
| `raw_device_snapshots.lat/lon` | Stored (1.85 M rows) but **read by nothing downstream** |
| `hard-filters.ts` `VEHICLE_ON_TRIP` | Reachable only if `vehicleReadiness === 'ON_TRIP'`; `recommender.service.ts:283` hardcodes `'UNKNOWN'` — **unreachable code** |
| Presence table / service | **Does not exist** |
| `vehicle_unavailability_reports` | 0 rows |

**Decision 2 requires zero implementation work.** It is a decision to leave the system as it is on this
axis. Nothing needs removing either — the one dead filter is inert.

### 4.2 Impact on the scheduler

**Behavioural impact: none.** The scheduler continues to dispatch on device silence alone.

**Consequential impact, stated plainly so the decision is made with open eyes:**

1. The scheduler will keep dispatching SEs to vehicles that are not at the plant, at whatever the true
   rate is. That cost is now accepted by decision rather than unknown.
2. **The Special Ticket becomes the system's only detector of that failure**, and it is a *lagging*
   one — it can only report after the fact, and only if the field reports back.
3. The `VEHICLE_ON_TRIP` hard filter is now permanently dead by decision. It should either be deleted
   or carry a comment saying it is intentionally inert — a filter that silently never fires is the
   kind of thing that misleads the next reader. (Flagging, not recommending a change beyond your scope.)

**One dependency worth naming:** Decision 2 and the Special Ticket are coupled. Removing the predictive
signal makes the reactive signal load-bearing — and §5 shows the reactive signal cannot currently fire.

---

## 5. Special Ticket Logic — What the Data Can Actually Prove

### 5.1 The blocking finding

> **In the current system, a ticket cannot become "repeatedly assigned but not troubleshot" through
> any automatic path, because nothing ever re-assigns it.**

Restating §2.4 concretely: dispatched → not worked → `ScheduleClosureScheduler` marks the *schedule*
`PARTIAL` → the *ticket* stays `FORMALLY_ASSIGNED` → the recommender (which reads `UNASSIGNED` only)
never sees it again. 7,590 live batch rows sit on PARTIAL schedules in exactly this state.

Repeat assignment has only ever happened via 20 human `BULK_UNASSIGN_ZONE` operations. Max assignments
for any ticket: **2**. Never 3.

**This is a prerequisite your design needs and the system does not have.** I am flagging it rather than
designing it, per your instruction. See §15, decision (a).

### 5.2 What existing records could prove the two halves

**"Was assigned" — strong evidence, already available:**

| Record | What it proves | Availability |
|---|---|---|
| `batch_assignment_tickets` (one row per dispatch; `removed_at` partial-unique keeps one live) | **Every assignment attempt, with timestamp** | 15,092 rows — this is a complete, reliable attempt ledger |
| `batch_assignment_tickets.removed_at` / `removed_by` | Whether the attempt was withdrawn, and by whom (NULL = system) | 6,799 human-removed · 1,092 system-removed · 8,293 live |
| `plant_batch_assignments` → `work_schedules.status` | Whether the day the attempt belonged to finished (`COMPLETED`) or not (`PARTIAL`) | Populated |
| `recommendations` (`SUGGESTED`/`DISPATCHED`, `processingRank`) | That the engine chose an SE | 148,991 rows |
| `dispatch_decision_traces` | Why that SE, who the runners-up were | Populated |

**"Was not troubleshot" — evidence exists but is unpopulated here:**

| Record | What it proves | Rows |
|---|---|---:|
| `troubleshooting_submissions` | The definitive positive: the SE submitted the form | **0** |
| `ticket_events` `to_state = VERIFICATION_PENDING` | Same event, on the lifecycle timeline | **0** |
| `failure_cycles.state = SUBMITTED` | Same, cycle side | — |
| `soft_states` `ON_SITE` / `TROUBLESHOOT_STARTED` | The SE physically arrived / began | **17** |
| `soft_states.onsite_source` (`AUTO_GEOFENCE` / `MANUAL`) | How arrival was established | 17 |
| `vehicle_unavailability_reports` | The SE went and the vehicle was gone | **0** |
| `component_blocked_queue` / `WAITING_COMPONENT` | Blocked on parts, not on access | — |

### 5.3 The minimum reliable rule derivable today

Using only what exists and is trustworthy:

```sql
-- attempts: complete and reliable
attempts(ticket) = COUNT(*) FROM batch_assignment_tickets WHERE ticket_id = :t

-- never troubleshot: reliable as a negative, because a submission is the only writer
never_troubleshot(ticket) =
     NOT EXISTS (SELECT 1 FROM troubleshooting_submissions WHERE ticket_id = :t)
 AND NOT EXISTS (SELECT 1 FROM ticket_events
                  WHERE ticket_id = :t AND to_state = 'VERIFICATION_PENDING')

-- still live work
still_open(ticket) = tickets.status = 'OPEN'
```

`SPECIAL := attempts >= N AND never_troubleshot AND still_open`

**This rule is sound and needs no new data.** What it *cannot* do is explain **why**, and that
distinction matters operationally:

| The SE… | Distinguishable today? | From what |
|---|---|---|
| never opened the ticket | **Yes** — no `soft_states` row at all | `soft_states` |
| opened it but never went | **Yes** — `VIEWED` but no `ON_SITE` | `soft_states` |
| went, vehicle absent | **Yes** — `vehicle_unavailability_reports` row | VU table |
| went, blocked on a part | **Yes** — `WAITING_COMPONENT` / `component_blocked_queue` | cycle state |
| went, worked it, form failed to sync | **No** — indistinguishable from "never went" | — (mobile has an offline write queue, so this is real) |
| was never a real SE (seeded/inactive) | **No** | — |

So: **attempt counting is reliable; attribution depends on `soft_states` and `vehicle_unavailability_reports`
being populated in production.** Both are at ~0 rows here, so the attribution half is unproven in
practice even though the schema supports it.

---

## 6. Special Ticket Definition

### 6.1 What the code determines (no business input needed)

| Question | Answer from the code |
|---|---|
| **Where is the attempt counter?** | `batch_assignment_tickets` — one row per dispatch, never deleted. No new counter column is strictly needed. |
| **Does every assignment count?** | Every dispatch writes a row, so mechanically yes. Whether it *should* is business (§15). |
| **Does a cancelled/withdrawn assignment count?** | Distinguishable: `removed_at IS NOT NULL` with `removed_by IS NOT NULL` = a human withdrew it. `ScheduleClosureScheduler`'s own comment states the intent: *"removed tickets (`removedAt`) are a ZM's withdrawal, not unfinished work"*. The system already treats withdrawal as **not** a failed attempt. |
| **Does a VU report count?** | It is a *distinct outcome*, currently with zero effect on assignment. It proves the SE attended, which is the opposite of "never worked". |
| **Does troubleshot-then-failed-again count?** | **No — and it must not.** That path writes a `troubleshooting_submissions` row, so `never_troubleshot` is false. It is already modelled as REPEAT. |
| **How does Special differ from REPEAT / ESCALATED?** | See table below — they are near-opposites. |

### 6.2 Special vs REPEAT vs ESCALATED — these must not be conflated

| | Trigger | Was the device worked on? | Where defined |
|---|---|---|---|
| **REPEAT** | Re-failure within 24 h of a **VERIFIED** closure | **Yes** — fixed, then broke again | `ticket-creation.service.ts`, `REPEAT_WINDOW_MS`; `failure_cycles.repeat_failure`, state `REPEAT` |
| **ESCALATED** | **3** repeat episodes in **7 days** | **Yes** — repeatedly fixed, repeatedly broke | `RepeatEscalationService`, ADR-0021 |
| **SPECIAL** (yours) | N assignments, **no** submission | **No** — never worked at all | *Does not exist* |

REPEAT and ESCALATED describe a device the SE **did** touch. Special describes one they **did not**.
Reusing either vocabulary would be a genuine correctness hazard — `RepeatEscalationService` reads
`failure_cycle.repeat_failure` to count chronic devices, and polluting that with never-attempted
tickets would corrupt the escalation threshold.

### 6.3 Should Special be a new ticket type?

**Evidence, not preference:**

- `TicketStatus` is an enum of 15 values spanning three work types (TROUBLESHOOT / INSTALL / RECOVERY),
  and it encodes **lifecycle position** (`OPEN`, `SUBMITTED`, `VERIFICATION_PENDING`, `CLOSED`, …). A
  Special ticket is still `OPEN` — it has not moved anywhere in its lifecycle. Adding `SPECIAL` to this
  enum would mean a ticket can no longer say it is OPEN, which breaks `RESOLVED_TICKET_STATUSES` in
  `ScheduleClosureScheduler`, the recommender's `status: 'OPEN'` selector, `AutoRecoveryService`, and
  the shared-pool read.
- `AssignmentState` is binary (`UNASSIGNED` / `FORMALLY_ASSIGNED`) and is about *where the ticket sits*,
  not *how it has behaved*.
- `work_type` is the ticket's kind of work (TROUBLESHOOT / INSTALL / RECOVERY) — Special is not a
  different kind of work.

**Conclusion from the code: Special cannot be a value in any existing enum without breaking a
consumer.** It is an *attribute* of a ticket, orthogonal to status.

Two representations are consistent with the architecture. **Which one you want is a business/ops
decision, not a code-determined one** (§15):

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **A — Derived view** | No schema change. `SPECIAL` = a query over `batch_assignment_tickets` + `troubleshooting_submissions` | Zero migration; cannot drift from truth; retroactive over all history | Cost per read; cannot be indexed cheaply; no place to record *why* |
| **B — Materialised flag** | `tickets.assignment_attempt_count` (int) + `tickets.special_since` (timestamptz) + `tickets.special_reason` (text) | Indexable; sortable by the scheduler; carries attribution | Must be maintained at dispatch; can drift; needs a backfill |

If Special is only ever *identified* (your stated purpose — "the purpose is to identify"), **A is
sufficient**. If it must influence scheduling order, **B is required**, because `canonicalSort` needs a
column it can sort on.

### 6.4 The threshold

**The current system does not define one.** There is no setting, no constant, no precedent for
"N assignments without resolution". The adjacent constants are `REPEAT_THRESHOLD = 3` and
`ESCALATION_WINDOW_MS = 7 days` in `RepeatEscalationService` — but those count *repeat failures*, a
different quantity.

**This is a business decision (§15).** I will note only what the data constrains: with a maximum
observed assignment count of **2**, any threshold of 3 or more would currently match **zero tickets**
until recycling exists.

---

## 7. Return Date Behaviour

### 7.1 What happens today — exactly

```text
SE opens VehicleUnavailabilityFormScreen (mobile — exists and is wired)
    ↓  POST /api/vehicle-unavailability { ticketId, seId, reasonCode, expectedFrom, expectedTo, … }
VehicleUnavailabilityService.fileReport()
    ├── INSERT vehicle_unavailability_reports (expectedFrom, expectedTo, reason, transporter, GPS)
    ├── failure_cycle.slaPaused = true, slaPauseReason = 'VEHICLE_UNAVAILABLE'   (primary only)
    └── ticket.lastStateChangedAt = now
    ↓
ticket.assignmentState   → UNCHANGED (FORMALLY_ASSIGNED)
ticket.deferredUntil     → UNCHANGED (NULL)
batch_assignment_tickets → UNCHANGED (row stays live)
    ↓
Next 05:00 run: ticket is FORMALLY_ASSIGNED → invisible to the recommender → never re-planned
Expected return date arrives: NOTHING happens. No job reads expectedFrom.
SLA resume: manual only (ZM calls resumeSla(), which also resolves the report)
```

**Net effect today: the date the SE types in is stored and then has no consequence whatsoever.**

### 7.2 What exists that your design can use

| Primitive | Where | State |
|---|---|---|
| `expectedFrom` / `expectedTo` (date the SE enters) | `vehicle_unavailability_reports` | Captured; **0 rows** so far |
| Mobile capture UI | `VehicleUnavailabilityFormScreen.tsx` | Built |
| `tickets.deferred_until` (DATE) | `tickets` | Built; **0 rows** |
| `notDeferredOn(day)` — the one shared "is it still held back?" predicate | `ticketing/deferral.ts` | Built; spread into recommender, shared pool, intraday, cross-zone, `me-tickets` |
| Return-to-pool semantics (`UNASSIGNED` + `deferredUntil`) | `override.service.ts:203` (`DEFER_TICKET`) | Built — this is the exact shape your flow needs |
| Deferral cleared on re-dispatch | `batch-assignment.service.ts:182` | Built |
| Dual SLA clocks (primary pausable, secondary never) | `failure_cycles` | Built |

### 7.3 What is missing for your stated flow

Mapping your flow to the code:

| Your step | Supported? | Gap |
|---|---|---|
| SE enters return date | **Yes** | — |
| Ticket waits | **Partially** | It "waits" only in the sense of being stuck assigned. It is not in a pending pool, and no date governs it. Needs `deferredUntil = expectedFrom` **and** `assignmentState = UNASSIGNED` **and** removal from the live batch — the three writes `DEFER_TICKET` already performs together. |
| Return date arrives | **Yes, mechanically** | `notDeferredOn(istDate(now))` is inclusive on the deferral date, so the ticket re-enters the selectable set on exactly that day. No new job needed. |
| Ticket **gets priority** | **No** | Nothing in `canonicalSort` or the SE-selection path can express this. See §8. |
| Scheduler assigns it | **Yes** | Normal path, once it is `UNASSIGNED` and not deferred. |

Two further gaps that follow from the same place:

- **SLA resume.** Filing pauses the primary SLA. Only `resumeSla()` (manual, ZM) un-pauses it. If the
  ticket auto-returns on the expected date, the SLA does not auto-resume with it — the ticket would be
  dispatchable while its primary clock is still paused. Whether that is acceptable is a business call
  (§15).
- **Report lifecycle.** `vehicle_unavailability_reports.status` goes to `RESOLVED` only via
  `resumeSla()`. An auto-returning ticket would leave an `OPEN` report behind indefinitely.

---

## 8. Priority Semantics — the choice I am not making for you

Your decision says the ticket "should receive priority in scheduler" on the return date. The current
scheduler has exactly one ordering mechanism and one selection mechanism:

- **Ordering:** `canonicalSort` — Company Tier ↓ → Device Bucket ↓ → Company Priority Rank ↑ → Oldest
  Inactive ↑ → Device ID ↑. Pure, deterministic, spec-pinned to ADR-0017, and mirrored as a SQL
  `ORDER BY`.
- **Selection:** strict coverage precedence + five hard filters. **The score does not select the SE** —
  `chosen = planner-bias ?? passed[0]`. `scoreCandidate()` output is persisted for explainability only.

So "priority" must be expressed in `canonicalSort` or in a pre-pass around it. Five coherent options,
with what each actually does:

| # | Interpretation | Mechanism | Effect |
|---|---|---|---|
| **1** | **Eligibility only** — the ticket simply becomes selectable again; no ordering change | `deferredUntil` expires; no sort change | Least invasive; ADR-0017 untouched. But a returned ticket competes with a 60-day-old SEVERE one and may lose for days |
| **2** | **Top of the run** — returned tickets are processed before everything else | Pre-pass: partition the run list, returned-today first | Strongest guarantee of "gets priority". Can starve older/higher-tier work on a busy day |
| **3** | **Above normal, below CRITICAL+** | New sort key evaluated after Device Bucket for buckets < CRITICAL | Respects SLA severity; matches "priority but not emergency" |
| **4** | **Bucket promotion** — treat a returned ticket as one bucket more urgent | Adjust `deviceBucket` for sorting only | Reuses existing machinery; but the bucket is an SLA measurement and overloading it would corrupt reporting |
| **5** | **Reserved capacity** — a share of each SE's daily capacity is held for returned tickets | New capacity accounting in the recommender | Bounded and fair; most complex |

**What the code favours:** option **1** is free and breaks nothing. Option **3** is the smallest change
that delivers what you asked for while keeping SLA severity dominant. Options **2** and **4** each
create a real hazard (starvation; corrupted SLA reporting). Option **5** is a larger change than the
rest of your design.

**I am not choosing.** This is business rule §15(c).

One technical constraint that bounds the choice: `canonicalSort` is a pure comparator with a matching
SQL `ORDER BY` and is spec-pinned. Any new term must be added in **both** places or they drift — the
codebase has already been burned by exactly that class of bug (#153, six copies of a liveness filter).

---

## 9. Edge Cases

Analysed against the actual predicates. "Today" = current code; "Under your design" assumes
`deferredUntil = expectedFrom` + `UNASSIGNED` + removal from batch.

| # | Case | Today | Under your design | Notes / gaps |
|---|---|---|---|---|
| 1 | **Return date = today** | Nothing | `notDeferredOn` is **inclusive** (`deferredUntil <= day`), so it is immediately selectable | Works. But if the 05:00 run already passed, it waits until tomorrow — unless a manual run is triggered |
| 2 | **Return date = tomorrow** | Nothing | Excluded today, included tomorrow | Works, exactly as `deferral.ts` documents |
| 3 | **Return date changed** | Report row can be edited by ZM; no scheduling effect | Needs `deferredUntil` re-written from the new `expectedFrom` | **Gap:** the current edit path (`confirm/edit the date`) does not write `deferredUntil`. Which date wins if SE and ZM disagree is a business call |
| 4 | **Vehicle returns early** | Nothing — no detector | Ticket stays deferred until the stated date | **Accepted consequence of Decision 2.** Early return is only detectable from vehicle location, which you have ruled out. Only a human (ZM `resumeSla`, or an override) can pull it forward |
| 5 | **Vehicle returns late** | Nothing | Ticket returns on the stated date, is dispatched, SE finds it absent, files a **new** VU report with a new date | Self-correcting loop — and **this is what makes it "repeatedly assigned", i.e. the Special path** |
| 6 | **Vehicle never returns** | Ticket stranded assigned; primary SLA paused indefinitely | Loops: defer → dispatch → VU → defer … Secondary SLA keeps running | **Needs a bound.** Nothing caps deferrals or `expectedFrom` distance. Special is the intended catcher — see §15(a) |
| 7 | **Ticket assigned before the return date** | Possible only via manual override | Blocked by `notDeferredOn` on the automatic path; **still possible** via `OverrideService.assignTicket` / `assignPlants` / `SPLIT_BATCH`, which do **not** check deferral | **Gap:** manual assignment bypasses the hold. May be intentional (ZM authority) — your call |
| 8 | **Ticket assigned on the return date** | n/a | Normal path; priority per §8 choice | Works |
| 9 | **Becomes Special before the return date** | n/a | Both are true simultaneously — Special counts past attempts, deferral governs the future | No conflict, provided Special is an attribute (§6.3) not a status |
| 10 | **Special ticket returns** | n/a | Re-enters the pool carrying its attempt count | Works with option A or B. With B the counter must **not** reset on dispatch |
| 11 | **Resolved after becoming Special** | n/a | `troubleshooting_submissions` row exists → `never_troubleshot` false → no longer Special | **Self-clearing with option A.** With option B, `special_since` must be cleared explicitly on submission — an easy thing to forget |
| 12 | **Repeatedly assigned, SE never reaches plant** | Cannot recur (no recycling) | The core Special case | Distinguishable via `soft_states` (no `ON_SITE`) **only if** soft states are populated — currently 17 rows |
| 13 | **Assigned, SE reports another reason** | `WAITING_COMPONENT` / `component_blocked_queue` pause the SLA separately | Must **not** count as Special — the SE did attend | `fileReport` only pauses if `!cycle.slaPaused`, so a component-blocked cycle will **not** be re-paused by a VU report. Ordering-dependent; worth a test |
| 14 | **Closed, then device inactive again** | `AutoRecoveryService` closes on recovery; a new silence opens a **new** `failure_cycle` + **new** ticket | New ticket, attempt count starts at 0 | Correct — attempts are per-ticket, and `batch_assignment_tickets.ticket_id` guarantees that. If the re-failure is within 24 h it is also a REPEAT, which is orthogonal |

---

## 10. Scheduler Flow Under Your Decisions Only

Derived from the real call graph. **New** marks what does not exist today; everything else is current
behaviour, unchanged.

```text
── Continuous ────────────────────────────────────────────────────────────────
AutoPlant → AutoPlantSourceReader → SnapshotIngestionService → device_states
DeviceStateService.recompute()   → inactivity_hours, sla_bucket, eligible_for_uptime
TicketCreationService            → failure_cycle(OPEN) + ticket(OPEN, UNASSIGNED)
                                   [no location input — Decision 2]

── Field feedback (whenever it happens) ──────────────────────────────────────
SE files vehicle unavailability with expectedFrom:
    (today)  INSERT vehicle_unavailability_reports
    (today)  failure_cycle.slaPaused = true (primary only; secondary keeps running)
    NEW      ticket.deferredUntil   = expectedFrom
    NEW      ticket.assignmentState = UNASSIGNED
    NEW      remove from live batch  (batch_assignment_tickets.removed_at = now)
    NEW      record the attempt outcome for Special counting
    OPEN Q   does the primary SLA auto-resume on expectedFrom?          → §15(d)

── Admin, any time before the run (Decision 1) ───────────────────────────────
GET /api/schedules/preview?date=D                                        NEW
    → RecommenderService.runForZone(zone, { dryRun: true, targetDate: D }) NEW
    → returns projected { se → plant → tickets }, persists NOTHING
    → response carries an HMAC preview token          (pattern: BulkUnassignService)

Admin optionally holds:  ticket.deferred_until = D + 1        (existing primitive)
Admin optionally changes: LIMITED — see §3.2(2), no pre-run batch exists      → §15(b)
Admin does nothing:      run proceeds normally                    ← Decision 1

── 05:00 IST (or manual POST /api/schedules/dispatch-run) ────────────────────
DispatchRunService.runForActiveZones()
  for each active zone:
    RecommenderService.runForZone(zone)
      tickets = OPEN + UNASSIGNED
              + notDeferredOn(today)        ← holds AND return dates, one predicate
              + plant active, in zone
              + device not departed
              + (inactivityHours >= threshold OR NULL OR no state row)
      [NO presence filter — Decision 2]

      order = canonicalSort(tickets)                                (unchanged)
      NEW   + return-date priority term, per the §8 choice          → §15(c)

      for each ticket in order:
        candidates = CandidateSelectionService.orderedCandidatesForPlant()  (unchanged)
        readiness  = applyHardFilters(candidates)                            (unchanged)
        chosen     = planner-bias ?? passed[0]                               (unchanged)
        capacity   = committedDayLoad + in-run increments                    (unchanged)
        → recommendations(SUGGESTED) + dispatch_decision_traces

    BatchAssignmentService.dispatchForZone(zone)            (unchanged)
      per-zone advisory lock
      → work_schedules → plant_batch_assignments → batch_assignment_tickets
      → ticket.assignmentState = FORMALLY_ASSIGNED, deferredUntil = NULL
      NEW → increment the attempt counter (option B only)
      → recommendations SUGGESTED → DISPATCHED

── 04:00 next day ───────────────────────────────────────────────────────────
ScheduleClosureScheduler → work_schedules COMPLETED | PARTIAL
    GAP → nothing returns unresolved tickets to UNASSIGNED               → §15(a)
          without this, no ticket is ever assigned a second time,
          and Special can never trigger.

── Identification (Special) ─────────────────────────────────────────────────
SPECIAL := attempts >= N AND no troubleshooting_submission AND status = OPEN
    surfaced in admin; N is a business decision                          → §15(e)
```

---

## 11. Data Model Impact

### Reusable as-is — no change

| Field / table | Used for |
|---|---|
| `tickets.deferred_until` (DATE) | Both the admin hold and the return date. Already spread through five readers via `notDeferredOn()` |
| `tickets.assignment_state` | Returning a ticket to the pool |
| `batch_assignment_tickets` | **The attempt ledger** — one row per dispatch, `removed_at`/`removed_by` distinguishes withdrawal from failure |
| `vehicle_unavailability_reports.expected_from` / `expected_to` | The SE's return date; already captured by the mobile form |
| `troubleshooting_submissions` | The definitive "was troubleshot" proof |
| `ticket_events` | Lifecycle audit of every transition |
| `soft_states` (`VIEWED` / `ON_SITE` / `TROUBLESHOOT_STARTED`) | Attribution: did the SE look / arrive / start |
| `failure_cycles.sla_paused` + `sla_pause_reason` + secondary clock | SLA behaviour while waiting |
| `audit_logs` | Admin hold/change history (the bulk-unassign precedent) |
| `system_settings` | Where a Special threshold would live |

### Would be required — new

**For the return date:** nothing new. The primitives exist.

**For Special — depends on §6.3:**

*Option A (derived view):* no schema change. Possibly one index:

```sql
CREATE INDEX ON batch_assignment_tickets (ticket_id);   -- today only (batch_id) is indexed
```

*Option B (materialised):*

```sql
tickets.assignment_attempt_count  int NOT NULL DEFAULT 0
tickets.special_since             timestamptz NULL
tickets.special_reason            text NULL
INDEX ON tickets (special_since) WHERE status = 'OPEN';
system_settings 'special_ticket_attempt_threshold'
```

**For Decision 1:** nothing new **if** holds are `deferred_until` only. If admin must make richer
pre-run changes (§3.2(2)), a pre-assignment override table would be needed — but that is a design gap
in the decision as stated, not something I should specify.

**Explicitly NOT required by your decisions:** `plants.location`, any presence column, any presence
table, capacity-model changes.

---

## 12. Code Impact

Listed, not modified.

### Decision 1 — preview

| File | Change |
|---|---|
| `recommender/recommender.service.ts` | Add a dry-run mode that persists no `recommendations` / traces; parameterise `istDate(now)`, `committedDayLoad()`, `plannerForDate()` by target date |
| `engineers/se-availability.service.ts` | `currentStatus(seId, now)` → accept a target date (data model already supports future windows) |
| `scheduling/dispatch-run.service.ts` | Preview orchestration across zones |
| `scheduling/schedules.controller.ts` | `GET /api/schedules/preview` (+ token, mirroring `bulk-unassign`) |
| `scheduling/bulk-unassign.service.ts` | **Reference only** — `signPreviewToken` / `verifyPreviewToken` / `TOKEN_STALE` are the pattern to reuse, not to fork |
| `apps/admin/src/pages/schedules/` | New preview page; `admin/BulkUnassignPage.tsx` is the UI precedent |

### Return date

| File | Change |
|---|---|
| `ticketing/vehicle-unavailability.service.ts` | `fileReport()`: also set `deferredUntil = expectedFrom`, `assignmentState = UNASSIGNED`, stamp `removed_at` on the live batch row. The date-edit path must rewrite `deferredUntil` |
| `recommender/canonical-sort.ts` **+** `recommender/recommender.service.ts` | The §8 priority term — **both** the comparator and the SQL `ORDER BY`, or they drift |
| `scheduling/override.service.ts` | Reference: `deferTicket()` already performs the exact three-write pattern needed |
| `apps/mobile/src/tickets/vehicle-unavailability/VehicleUnavailabilityFormScreen.tsx` | Surface "this ticket returns on {date}" so the SE sees the input has an effect |

### Special

| File | Change |
|---|---|
| `ticketing/` (new) `special-ticket.service.ts` or a query in `ticket-query.service.ts` | The detection rule |
| `scheduling/batch-assignment.service.ts` | Option B only: increment the attempt counter at dispatch |
| `ticketing/troubleshoot-submission.service.ts` | Option B only: clear `special_since` on submit |
| `apps/admin/src/pages/tickets/` | Special view / column |

### Must not change

- `ticketing/deferral.ts` — one shared predicate; forking it is the #153 failure mode
- `recommender/canonical-sort.ts` semantics — spec-pinned (ADR-0017); **add** a term, do not reorder existing ones
- `RepeatEscalationService`, `failure_cycles.repeat_failure` — REPEAT/ESCALATED must stay uncontaminated
- Per-zone advisory lock + partial-unique backstops in `batch-assignment.service.ts`
- `hard-filters.ts` — Decision 2 means no presence filter is added

---

## 13. Conflicts With the Existing System

| Area | Conflict? | Detail |
|---|---|---|
| **SLA** | **Yes — needs a decision** | `fileReport()` pauses the primary SLA; only manual `resumeSla()` un-pauses. An auto-returning ticket would be dispatchable with its primary clock still paused, and its VU report still `OPEN`. §15(d) |
| **Priority** | **Yes — by construction** | Any return-date term modifies `canonicalSort`, which is ADR-0017 spec-pinned and mirrored in SQL. Must change in both places |
| **Deferral** | **No** | `deferredUntil` + `notDeferredOn()` is exactly the right primitive, currently unused (0 rows). `batch-assignment.service.ts:182` clearing it on dispatch is correct |
| **Assignment state** | **No** | `DEFER_TICKET` already demonstrates the `UNASSIGNED` + `deferredUntil` + remove-from-batch combination |
| **REPEAT** | **Only if names are reused** | REPEAT = fixed then re-broke (submission exists). Special = never worked (no submission). Mutually exclusive by definition; keep them in separate fields |
| **ESCALATED** | **Only if the counter is shared** | `RepeatEscalationService` counts `failure_cycle.repeat_failure` rows. Special must never write that flag or the 3-in-7 threshold corrupts |
| **SE Planner** | **No** | Soft bias among eligible candidates; 2 rows; unaffected. If preview covers a future date it should read the planner for **that** date, not today |
| **Daily 05:00 scheduler** | **No** | Holds are read through the existing predicate. No new lock, no new ordering dependency |
| **Overrides** | **Yes — a bypass** | `assignTicket` / `assignPlants` / `SPLIT_BATCH` do **not** consult `notDeferredOn`. A ZM can assign a deferred ticket. May be intended (§9 case 7) |
| **Vehicle unavailability** | **Yes — semantic shift** | Today filing is a *record*; under your design it becomes a *scheduling action*. Report resolution (`status = RESOLVED`) currently happens only via `resumeSla()` and would need a defined lifecycle |
| **Bulk unassign** | **Interaction** | `classifyZone` has a `deferredExcluded` class, so it already understands deferred tickets. Whether a bulk unassign should clear return-date deferrals is undefined |
| **Auto-recovery** | **No** | Closes tickets when the device reports again, independent of assignment. A deferred ticket whose device recovers closes normally |

---

## 14. Recommended Final Interpretation

The cleanest implementation of **your** design, using only what your decisions imply.

### Decision 1 — preview

Build `GET /api/schedules/preview?date=D` as a **dry run of the real recommender** (not a
reimplementation), returning the projected `SE → plant → tickets` plan plus an HMAC preview token, in
the exact shape `BulkUnassignService` already uses — including `TOKEN_STALE` returning a fresh preview
when the world has moved.

Admin **hold** = write `tickets.deferred_until`. Nothing else. The 05:00 run reads it through the
existing `notDeferredOn()` predicate, so no coordination between admin and scheduler is needed, and
inaction changes nothing — which is the whole of Decision 1.

Admin **change** beyond holds is not expressible today (§3.2(2)) and needs scoping from you.

### Decision 2 — no location rule

Change nothing. Optionally annotate the inert `VEHICLE_ON_TRIP` filter as deliberately dead so it does
not mislead.

### Return date

Extend `fileReport()` to perform the same three writes `OverrideService.deferTicket()` already
performs:

```text
ticket.deferredUntil   = expectedFrom
ticket.assignmentState = UNASSIGNED
batch_assignment_tickets.removed_at = now      (reason: VEHICLE_UNAVAILABLE)
```

The ticket then returns to the selectable set on exactly the stated date, via machinery that already
exists and is already spread through every reader. Priority on that date = the §8 option you choose.

### Special

Implement as **identification only**, matching your stated purpose. Start with **option A** (a derived
query — no schema change, retroactive, cannot drift):

```text
SPECIAL := COUNT(batch_assignment_tickets WHERE ticket_id = t) >= N
       AND NOT EXISTS (troubleshooting_submissions WHERE ticket_id = t)
       AND tickets.status = 'OPEN'
```

Surface it in the admin ticket views with the attribution `soft_states` and
`vehicle_unavailability_reports` provide (never viewed / viewed but not on site / on site but no
submission / vehicle absent). Move to option B only if Special must later influence scheduling order.

**Do not** add `SPECIAL` to `TicketStatus`, `AssignmentState`, or `work_type`, and do not write
`failure_cycle.repeat_failure`.

### The prerequisite this design needs and does not have

None of the Special logic can fire until something returns unresolved tickets to `UNASSIGNED` after
their day plan closes. That is a real gap (§2.4, §15(a)) — I am flagging it, not designing it, because
it is a behavioural change to the scheduler and therefore yours to decide.

---

## 15. Decisions Still Required From You

Only items the code and data cannot settle.

**(a) Should an unresolved ticket automatically return to the pool when its day plan closes?**
Today it does not — 7,590 live batch rows sit on PARTIAL schedules and no ticket has ever been
assigned three times. Without this, **the Special Ticket can never trigger** and the return-date loop
cannot repeat. This is the load-bearing decision of the whole design. Sub-questions: should the
`ScheduleClosureScheduler` do it, or a separate sweep? Should it apply to every unresolved ticket, or
only those with no `soft_states` activity?

**(b) What exactly may an admin change in the preview, beyond holding?**
"Change the plan" has nothing to attach to before dispatch — no batch exists yet. Options: holds only;
holds plus SE reassignment (needs a new pre-assignment table); or holds plus `se_planner` rows (soft
bias, not binding).

**(c) What does "priority on the return date" mean?**
The five options in §8. This changes ADR-0017's spec-pinned ordering, so it needs to be an explicit
ruling, not an implementation choice.

**(d) When the ticket auto-returns, should the primary SLA auto-resume, and should the VU report
auto-resolve?**
Today both are manual (`resumeSla()`). If neither resumes, a returned ticket is dispatchable with a
paused clock and an open report.

**(e) What is N — the number of assignments that makes a ticket Special?**
No precedent exists in the code. Note: at 3+, zero tickets currently qualify.

**(f) Which assignments count toward N?**
The code can distinguish them; which ones *should* count is yours: system dispatches, human
`REASSIGN`, bulk-unassign-then-reassign cycles, and attempts withdrawn by a ZM (`removed_by IS NOT NULL`
— which `ScheduleClosureScheduler` already treats as "not unfinished work").

**(g) Should a manual override be able to assign a deferred ticket before its return date?**
`assignTicket` / `assignPlants` / `SPLIT_BATCH` currently bypass `notDeferredOn`. This may be correct
(ZM authority overrides), but it is currently accidental rather than decided.

**(h) Is there a cap on deferrals or on how far out a return date may be set?**
Nothing bounds either today. Without a bound, a vehicle that never returns loops indefinitely with its
primary SLA paused; only the secondary clock keeps running.

---

## 16. Final Verdict

> ## Works with changes
>
> — for Decisions 1, 2, and the Return Date.
>
> ## The Special Ticket partially works: the detection rule is sound, but its trigger condition cannot occur in the current system.

**Why, precisely:**

**Decision 2 works as-is.** Nothing in the scheduler consumes vehicle location. `plants.location` is
NULL for all 933 rows, `device_states` has no position columns, and the one presence-shaped filter is
unreachable code. Your decision costs nothing to honour.

**Decision 1 works with changes, and the changes are modest** because the codebase has already built
this pattern once. `BulkUnassignService`'s preview → HMAC token → `TOKEN_STALE` → execute flow, with an
admin page to match, is a direct template. The real work is a dry-run mode on the recommender and
target-date parameters on three reads. Non-blocking coexistence with the 05:00 run is safe: holds are
`deferred_until` writes, read through a predicate that already exists and is already shared.

**The Return Date works with changes, and the primitives are all present** — `expectedFrom` is captured
by a mobile screen that already ships, `deferredUntil` + `notDeferredOn()` is a complete deferral
engine, and `OverrideService.deferTicket()` already demonstrates the exact three-write pattern. What is
missing is the connection between them, and a definition of "priority" (§8).

**Special is where the design meets a wall that is not of its own making.** The rule you want is
derivable and reliable — `batch_assignment_tickets` is a complete attempt ledger and
`troubleshooting_submissions` is an unambiguous "was worked" proof. But the condition it detects cannot
arise: a ticket that is dispatched and not worked stays `FORMALLY_ASSIGNED` forever, invisible to the
recommender. In 15,092 assignment rows, **no ticket has ever been assigned three times**, and the 4,849
double-assignments trace to 20 human bulk-unassign operations rather than to any system loop.

So Special will correctly identify nothing until decision (a) is made. That is not a flaw in your idea
— it is a missing behaviour underneath it, and it is worth knowing before rather than after
implementation.

**One coupling worth stating plainly:** Decision 2 removes the predictive signal, which makes Special
the only feedback path for the wasted-visit problem. Special depends on tickets recycling (decision a)
and on SEs reporting outcomes — `soft_states` has 17 rows and `vehicle_unavailability_reports` has 0.
The schema supports all of it; the field loop has never been exercised here. Whether that is a seeded
environment or a real adoption gap is worth confirming before relying on Special in production.

---

*Investigation only. No application code, database schema, migration, scheduler behaviour, production
data, or AutoPlant data was modified. Special Ticket logic and return-date priority were analysed, not
implemented.*
