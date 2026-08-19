# Four Decisions — Implementation-Readiness Analysis

**Analysis only. No code, migration, schema, issue, slice, production data, or AutoPlant change was made.**

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Decisions analysed** | 1 Non-blocking preview · 2 No vehicle-location rule · 3 Special Ticket (3, configurable) · 4 Return-date priority (Option C) |
| **Method** | Full re-trace of `apps/backend/src`, `apps/mobile/src`, `apps/admin/src`, Prisma schema, live FSM Postgres |
| **Prior reports** | Re-verified from source, not reused |

---

## Core answer

> **YES, WITH CHANGES — with one hard prerequisite and eleven blocking questions.**
>
> Decisions 1, 2 and 4 can be implemented cleanly. Decision 3 is sound in principle but rests on a
> lifecycle behaviour that **does not exist**, and its "count from when it reaches the SE mobile"
> rule cannot be satisfied as written, because **the system has no record that a ticket ever reached
> an SE's phone.**

---

## 1. Decision 1 — Non-blocking Preview: re-verified

### 1.1 Complete current flow (re-traced)

```text
cron dispatch_cron = "0 5 * * *" (Asia/Kolkata, from system_settings, not env)
  → DispatchSchedulerService  → DispatchRunService.runForActiveZones()
      opens dispatch_runs (RUNNING) + config snapshot at run start
      per zone:
        RecommenderService.runForZone(zone, {now, runId})
          reads: OPEN + UNASSIGNED + notDeferredOn(istDate(now)) + plant live/in-zone
                 + no active departure + threshold gate
          canonicalSort → per ticket: orderedCandidatesForPlant → applyHardFilters
          chosen = plannerBias ?? passed[0]              (score is NOT the selector)
          WRITES recommendations(SUGGESTED) + dispatch_decision_traces
        BatchAssignmentService.dispatchForZone(zone)
          pg_try_advisory_xact_lock(dispatch_zone_<id>)
          work_schedules → plant_batch_assignments → batch_assignment_tickets
          ticket.assignmentState = FORMALLY_ASSIGNED, deferredUntil = NULL
          recommendations SUGGESTED → DISPATCHED
      finalize dispatch_runs SUCCESS | PARTIAL | FAILED
```

### 1.2 Answers to your specific questions

| Question | Answer | Evidence |
|---|---|---|
| Future-date preview using the actual recommender? | **Not today.** `runForZone` is mutating by construction | It writes `recommendations` + traces, and calls `clearFinalizedOrphans(zoneId)` which **deletes** rows before suggesting |
| Can the preview be non-mutating? | **Yes, with a dry-run seam** — but it is not merely "skip the writes" | Three reads are `now`-bound: `istDate(now)` (deferral + planner), `committedDayLoad(istDate(now))` (capacity), `currentStatus(seId, now)` (availability). A preview of *tomorrow* run *today* would use **today's** capacity and availability |
| Can Admin hold tickets before the run? | **Yes — the primitive exists and is unused** | `tickets.deferred_until` + `notDeferredOn()`; **0 rows** in the DB today |
| Can Admin change assignments before the run? | **No** | Every `OverrideService` action operates on a `plant_batch_assignment` that does not exist until dispatch |
| What can Admin change *today*? | Only **after** dispatch: `REMOVE_TICKET`, `DEFER_TICKET`, `REORDER`, `SWAP_SE`, `REASSIGN`, `SPLIT_BATCH`, `assignTicket`, `assignPlants` | `scheduling/override.service.ts` |
| Which changes require new persistence? | Pre-run SE reassignment and pre-run priority change. A hold does not | — |
| Can 05:00 run safely if Admin did nothing? | **Yes, unchanged** | Holds are `tickets` writes; the run takes a per-zone advisory lock on scheduling tables. No shared lock, no ordering dependency |
| Manual run coexistence? | **Yes, safe** | Same code path, `trigger = MANUAL`; per-zone `pg_try_advisory_xact_lock` (skip, not wait), `SUGGESTED → DISPATCHED` consumption, `batch_assignment_tickets_one_active_per_ticket` partial unique, `GET /dispatch-run/in-flight` reports holders |
| What if the preview goes stale? | **A solved problem in this codebase** | `BulkUnassignService`: HMAC-SHA256 token over a `countsByZone` snapshot, 10-min TTL, `TOKEN_STALE` returns a **fresh preview** instead of executing |
| Can existing preview/hold mechanisms be reused? | **Yes — both** | `signPreviewToken`/`verifyPreviewToken` pattern; `deferred_until` + `notDeferredOn()`; UI precedent `apps/admin/src/pages/admin/BulkUnassignPage.tsx` |

### 1.3 Already supported / Partially supported / Requires new design

**Already supported**
- Preview → token → execute → `TOKEN_STALE` pattern, with admin UI precedent
- Hold primitive (`deferred_until`) and its shared read predicate across five consumers
- Manual run, in-flight detection, per-zone locking, run ledger + per-ticket decision traces
- Post-run transparency UI (`apps/admin/src/pages/dispatch/*`)

**Partially supported**
- Preview *content*: the recommender can produce it, but only for **today's** capacity/availability. Target-date parameters are needed on three call sites. The data model already supports future dates (`se_availability.windowStart/windowEnd`, `se_planner.planned_date`)
- Hold *scope*: `deferred_until` is a DATE on the ticket. Holding "this plant" or "this SE" for a day has no representation

**Requires new design**
- A non-mutating dry-run mode on `runForZone`
- Any pre-run **change** beyond a hold — there is no pre-assignment object to attach it to → **Question 11**

---

## 2. Decision 2 — No Vehicle-Location Rule: re-verified

### 2.1 Confirmations

| Check | Result |
|---|---|
| Presence condition in the scheduler | **None.** No presence table, service, column, or predicate |
| `plants.location` (PostGIS geometry) | Exists; **NULL for all 933 rows** |
| Position on `device_states` | **No lat/lon columns at all** |
| `raw_device_snapshots.lat/lon` | Stored (1.85 M rows), **read by nothing downstream** |
| AutoPlant integration forces location dependency? | **No.** `AutoPlantSourceReader` selects 9 columns; lat/lon land in raw snapshots and stop there |
| Scheduler works without location? | **Yes — it already does** |

**Decision 2 requires no work.** It is a decision to leave this axis alone.

### 2.2 Dead / latent code that could cause future confusion — flagged, not modified

1. **`hard-filters.ts` → `VEHICLE_ON_TRIP`.** `firstFailure()` returns it when `vehicleReadiness === 'ON_TRIP'`, but `recommender.service.ts:283` constructs **every** candidate with the literal `vehicleReadiness: 'UNKNOWN'`. The branch is unreachable. It does **not** contradict Decision 2 today, but a future author wiring `vehicleReadiness` from any source would silently reintroduce a location-shaped rule.
   *Also note:* `SeCandidateReadiness` describes the **Service Engineer's** readiness, not the tracked truck — so even if wired it would not be a vehicle-presence rule. Two different confusions in one field.

2. **`soft-state.service.ts` → `resolveOnsiteSource()` uses location.** This is the one live PostGIS query in the scheduling-adjacent code:
   ```sql
   SELECT ST_DWithin(p.location::geography,
                     ST_SetSRID(ST_MakePoint(:lng, :lat),4326)::geography,
                     200)
   FROM tickets t JOIN plants p ON p.plant_id = t.plant_id
   WHERE t.ticket_id = :id AND p.location IS NOT NULL
   ```
   Because `p.location` is NULL for every plant, this returns no rows and `onsiteSource` is **always `MANUAL`**, never `AUTO_GEOFENCE`.
   **This does not violate Decision 2** — it never touches scheduling. But it matters for Decision 3: geofence-verified arrival evidence **cannot exist today**, so `ON_SITE` is always self-declared.

3. **`plant_eligible_floating_se` MV** contains an `ST_Contains(etc.polygon, p.location)` branch that can never match (NULL locations). Floating eligibility resolves by district/region/state text only. Moot today — `engineer_territory_coverage` has **0 rows** and there are **0 FLOATING SEs**.

**No action requested. Recorded so the decision is not silently eroded later.**

---

## 3. Decision 3 — Special Ticket: deep investigation

### 3.A What proves the ticket reached the SE's mobile?

I traced the entire delivery path. **The honest answer is: nothing does.**

| Candidate signal | Per-ticket? | What it actually proves | Rows in DB |
|---|---|---|---:|
| `ticket.assignmentState = FORMALLY_ASSIGNED` | Yes | A server-side write. Nothing about the phone | 4,983 open |
| `batch_assignment_tickets` row | Yes | The ticket was placed on a day plan | 15,092 |
| `notifications` type `DAY_PLAN_DISPATCHED` | **No — schedule-level** | A notification was created. `SpineDayPlanNotifier` sets **no** `entityType`/`entityId` (its docstring says a day plan "isn't a single ticket entity to tap-route into") | 445 |
| `notifications.inAppReadAt` | **No — schedule-level** | The SE opened *a notification*, not a ticket | — |
| `notification_deliveries.status = SENT` | No | A **send attempt**. The docstring states the external send is a seam | 2,222 |
| `device_tokens` (FCM registration) | n/a | Push capability | **0 rows** |
| `GET /api/me/tickets` / `GET /api/me/tickets/:id` | — | **Nothing — pure reads, no server-side trace whatsoever** | — |
| **`soft_states` type `VIEWED`** | **Yes** | **The SE opened the ticket detail screen** | **17** |

`me-tickets.controller.ts` exposes only `@Get` routes. There is no acknowledgement, receipt, or sync-cursor endpoint. `MeTicketDetailService` only *reads* soft states (`findFirst`) — it does not create one.

**The one per-ticket signal that exists, and it is stronger than I expected:**

`apps/mobile/src/tickets/detail/TicketDetailScreen.tsx:96-109` **auto-posts `VIEWED`** in a `useEffect` when the detail screen reaches its ready state — not a button press:

```ts
// Auto-post VIEWED (CONTEXT §334: "SE has opened the Ticket detail") once, on the ready state —
// never once already past ON_SITE (a backward transition, 409s).
if (state.status !== 'ready' || state.detail.workType !== 'TROUBLESHOOT'
    || PAST_ON_SITE.has(state.detail.activeSoftState ?? '')) return;
await apiSetSoftState(token, ticketId, { target: 'VIEWED' });
```

So **`soft_states.VIEWED` is the authoritative, automatic, per-ticket proof that the ticket reached the SE's phone and was opened.** Constraints: TROUBLESHOOT-only; requires the SE to open the detail screen; auto-expires after 90 min (`viewed_soft_state_timeout_minutes`, resolved `VIEWED_TIMEOUT` by `SYSTEM`).

**The gap your rule runs into:** "reached the SE" and "was opened by the SE" are different events, and only the second is recorded. There is no signal for *delivered but never opened*.

**A second lifecycle fact that matters here.** `MeTicketsQueryService.getMyTickets` scopes to `liveScheduleFilter()` = `ACTIVE | OVERRIDDEN`. Once `ScheduleClosureScheduler` flips a schedule to `PARTIAL`/`COMPLETED`, the ticket **disappears from the SE's mobile** — while still being `FORMALLY_ASSIGNED` and therefore invisible to the scheduler. **A stranded ticket is in double limbo: no scheduler sees it, no SE sees it.**

### 3.B What proves an attempt started?

The soft-state chain `VIEWED → ON_SITE → TROUBLESHOOT_STARTED` (`ORDER` in `soft-state.service.ts`), one active state per SE per ticket, advancing resolves the prior (`resolutionReason = 'ADVANCED'`, `resolvedBy = 'SE'`).

| State | Set by | Automatic? | Expires? |
|---|---|---|---|
| `VIEWED` | Mobile, on detail-screen ready | **Yes** | Yes — 90 min → `VIEWED_TIMEOUT` by `SYSTEM` |
| `ON_SITE` | "Start Work" button; best-effort silent location capture (`captureLocation.ts` never throws) | No — deliberate | No (`timeoutAt` NULL). Stale warning after `onsite_stale_warning_hours` (2 h) |
| `TROUBLESHOOT_STARTED` | Deliberate action | No | No. Stale warning after 2 h |

`onsiteSource` is `AUTO_GEOFENCE | MANUAL` — but per §2.2(2) it is **always `MANUAL`** today.

**Authoritative "attempt started" signal: `soft_states.VIEWED`** (earliest, automatic, per-ticket). `ON_SITE` is the authoritative "SE physically attended", but it is self-declared and unverifiable.

### 3.C What proves successful troubleshooting?

Unambiguous and single-writer:

- **`troubleshooting_submissions`** — created by `TroubleshootSubmissionService.submit()`, idempotent on `(se_id, client_submission_id)`
- In the same transaction: ticket `OPEN → VERIFICATION_PENDING`, failure cycle `OPEN → SUBMITTED`, active soft states resolved, audit + `ticket_events` row

Any of `troubleshooting_submissions` row / `ticket_events.to_state = 'VERIFICATION_PENDING'` / `failure_cycles.state = 'SUBMITTED'` proves it. **Current rows: 0.**

### 3.D Case-by-case — what the code can determine, and what it cannot

**Legend:** *Code-determined* = the answer follows from the implementation. *Business* = you must decide.

| # | Case | Evidence signature | Counts toward 3? |
|---|---|---|---|
| **1** | Assigned, SE never opens it | `batch_assignment_tickets` row; **no `soft_states` row at all** | **UNKNOWN — Business.** Distinguishable. But by your own rule ("count from when it reaches the SE/mobile workflow") this arguably never *entered* the workflow → **Question 2** |
| **2** | SE opens, never reaches site | `VIEWED` (likely resolved `VIEWED_TIMEOUT`), **no `ON_SITE`** | **UNKNOWN — Business.** Clearly an attempt that started and failed |
| **3** | Reaches site, vehicle unavailable | `ON_SITE` + `vehicle_unavailability_reports` row (+ SLA paused) | **UNKNOWN — Business.** This is Decision 4's path; whether it also feeds Special decides whether a never-returning vehicle eventually becomes Special → **Question 5** |
| **4** | Reaches site, component unavailable | **A `troubleshooting_submissions` row EXISTS** — `componentUnavailable: boolean` and `componentUnavailableItem` are **fields on the troubleshoot form**; cycle → `WAITING_COMPONENT`; `submissionType` may be `COMPONENT_RESUBMIT` | **NO — Code-determined.** The SE diagnosed the fault. `never_troubleshot` is false |
| **5** | Starts troubleshooting, never submits | `TROUBLESHOOT_STARTED` active, no submission; stale-work warning after 2 h | **UNKNOWN — Business.** Strongest "genuine attempt, failed" case |
| **6** | Submits successfully | `troubleshooting_submissions` + `VERIFICATION_PENDING` | **NO — Code-determined** |
| **7** | Submits, mobile sync delayed/offline | `apps/mobile/src/api/writeQueue.ts` queues writes; submit is idempotent on `(se_id, client_submission_id)` — the row arrives **late** | **NO once synced — but a real hazard.** Counting before sync creates a **false Special** → **Question 6** |
| **8** | Admin removes/reassigns | `removed_at` NOT NULL **and** `removed_by` NOT NULL | **NO — strong code precedent.** `ScheduleClosureScheduler`: *"removed tickets (`removedAt`) are a ZM's withdrawal, not unfinished work, so they never hold a day open"* → ratify in **Question 4** |
| **9** | Manually deferred | `DEFER_TICKET` → `UNASSIGNED` + `deferredUntil` + `removed_at`/`deferred_to_date` stamped | **NO — same precedent as #8** → **Question 4** |
| **10** | Closed automatically | `AutoRecoveryService` closes on device recovery; status leaves `OPEN` | **NO — Code-determined.** Not `OPEN` ⇒ not Special |

---

## 4. Critical — Automatic Reassignment (the prerequisite)

### Current behaviour, traced

```text
05:00  dispatch → ticket FORMALLY_ASSIGNED, on a live (ACTIVE) work_schedule
       day passes, ticket not worked
04:00  ScheduleClosureScheduler.closeTick()      [gated on BUSINESS_SWEEPS_ENABLED]
         per zone, under the SAME dispatch_zone_<id> advisory lock (try-variant):
           work_schedules where dateTo < today AND status IN (ACTIVE, OVERRIDDEN)
           → PARTIAL if any live ticket is unresolved, else COMPLETED
         ── and that is ALL it does ──
       batch_assignment_tickets.removed_at  → still NULL
       ticket.assignmentState               → still FORMALLY_ASSIGNED
       next 05:00 recommender reads UNASSIGNED only → ticket invisible, forever
       SE's mobile reads liveScheduleFilter() → schedule no longer live → invisible
```

### Measured consequence

| Measure | Value |
|---|---:|
| Live batch rows (`removed_at IS NULL`) on **PARTIAL** schedules | **7,590** |
| …on COMPLETED | 384 |
| …on ACTIVE | 319 |
| Tickets OPEN + FORMALLY_ASSIGNED | 4,983 |
| Tickets ever assigned **3+** times | **0** |
| Tickets assigned exactly twice | 4,849 |
| Tickets assigned once | 6,486 |
| `BULK_UNASSIGN_ZONE` audit operations | **20** |
| `BATCH_OVERRIDE_DEFER_TICKET` / `REASSIGN` | 2 / 2 |
| `tickets.deferred_until` populated | **0** |

Every double-assignment traces to a **human** bulk-unassign. There is no automatic recycle.

### Why Special cannot work without it

Your threshold is **3**. The maximum any ticket has ever reached is **2**, and only because an Operations Head manually rebalanced a zone 20 times. Without automatic recycling, **`attempts >= 3` matches zero tickets, permanently.**

### The exact lifecycle change that would be required

At day-plan closure, for each live `batch_assignment_tickets` row whose ticket is unresolved:

```text
batch_assignment_tickets.removed_at = now      (removed_by = NULL ⇒ system)
ticket.assignmentState               = UNASSIGNED
ticket.deferredUntil                 = unchanged
record the attempt outcome for Special counting
```

Natural home: `ScheduleClosureScheduler.closeZone()` — it already runs before the 05:00 dispatch (04:00), already holds the right per-zone advisory lock, already computes the unresolved set to decide `PARTIAL`, and already distinguishes ZM-withdrawn rows from unfinished work.

### Possible side effects — all real, all foreseeable

1. **A 7,590-ticket backlog would be released at once** on first run. Against ~375 recommendations/run and 5,000+ `OVER_CAPACITY` drops, this would flood the queue → **Question 3**.
2. **Attempt counts start at zero** for those tickets; historical strandings are not retro-counted unless backfilled from `batch_assignment_tickets`.
3. **Capacity accounting.** `committedDayLoad()` counts non-removed batch tickets on **live** schedules. Closed schedules are already excluded, so stamping `removed_at` does not change capacity — verified, no impact.
4. **Lock contention.** The closure already takes the dispatch lock with the *try* variant; the crons are an hour apart (04:00 vs 05:00). Adding per-ticket writes inside that lock **widens the window**, and the file's own docstring warns: *"Anything added here that widens that window… trades a stale plan for a missing one."*
5. **The comment at `ScheduleClosureScheduler` line ~"removed tickets are a ZM's withdrawal"** would need care: system removal (`removed_by = NULL`) and ZM withdrawal (`removed_by` set) must stay distinguishable, since Case 8/9 depend on it.

**Not designed further here — this is Question 1.**

---

## 5. Special Threshold — configuration

### How configuration works today

`system_settings` (key, value JSONB, description, lock columns) with `SETTINGS_DEFAULTS` seeded
**only for missing keys**, so an operator's change survives redeploys. `settings/setting-authority.ts`
adds per-key write roles (default `OPERATIONS_HEAD`) plus lock/unlock reserved to
`SETTING_FINAL_AUTHORITY_ROLE = 'OPERATIONS_HEAD'`.

**`settings/assignment-threshold.ts` is the exemplary precedent** and should be followed exactly:

- a named key constant + description
- a **validated option ladder** (`ASSIGNMENT_THRESHOLD_OPTIONS`) — not free text
- a pure `parse…()` returning a typed rejection (`NOT_A_NUMBER` / `NOT_AN_ALLOWED_OPTION`), the **only** admission path, used by both the writer and the seed
- `coerceStored…()` that falls back to the default rather than gating the pipeline on an unparseable row
- `read…(prisma)` as a **free function** over a minimal `SettingReader`, **read per run, never cached**

### Answers

| Question | Answer |
|---|---|
| Where should it live? | `system_settings`, key e.g. `special_ticket_attempt_threshold`, mirroring `assignment-threshold.ts` |
| Is `system_settings` appropriate? | **Yes** — platform-wide operational policy, ops-owned, hot-read, already has authority + locking |
| Needs validation? | **Yes.** Precedent is a bounded ladder + pure parser + defensive coercion |
| Does 0 or 1 create invalid behaviour? | **0 = every ticket Special immediately** (meaningless). **1 = Special on first failed attempt**, which collapses Special into "any unworked ticket" — 7,590 rows on day one. Both are technically valid and operationally destructive → the ladder should have a **minimum of 2** |
| Does changing it affect existing tickets? | **Depends on derived vs stored** — the crux of §6. Derived: changing 3→2 reclassifies retroactively and instantly. Stored: only tickets crossing the threshold *after* the change flip, unless backfilled |
| Derived or stored? | See §6 and **Question 8** |

---

## 6. Special — Status vs Attribute vs Derived View

### Consumers traced

**`ticket.status`** — `RecommenderService` (`status: 'OPEN'`), `TicketCreationService`,
`AutoRecoveryService`, `ScheduleClosureScheduler.RESOLVED_TICKET_STATUSES`, `SharedPoolService`,
`MeTicketsQueryService` (`workStateFor`), `isTicketReadableBySe`, `RepeatEscalationService`,
`CrossZoneEscalationService`, `DeviceService.listDevices`, verification, reports, ops-explorer.

**`assignmentState`** — binary `UNASSIGNED | FORMALLY_ASSIGNED`; recommender selection, shared pool,
`isTicketReadableBySe`, `BatchAssignmentService`, `OverrideService`, `BulkUnassignService`.

**`workType`** — `TROUBLESHOOT | INSTALL | RECOVERY`; drives form routing and the soft-state chain
(the mobile auto-VIEWED is TROUBLESHOOT-only).

**REPEAT / ESCALATED** — `failure_cycles.repeat_failure` + state `REPEAT`; `RepeatEscalationService`
counts `repeat_failure = true` cycles opened in 7 days, escalating at 3.

### Verdict — code-determined

**Special must NOT be a `TicketStatus` value.** A Special ticket is still `OPEN`. Adding `SPECIAL`
would:

- remove it from the recommender's `status: 'OPEN'` selector → it would never be scheduled again
- change `RESOLVED_TICKET_STATUSES` arithmetic in `ScheduleClosureScheduler`
- break `SharedPoolService` and `isTicketReadableBySe` (both require `status === 'OPEN'`)
- change `workStateFor()` on mobile
- affect `AutoRecoveryService` closure matching

**Not `assignmentState`** — that answers *where the ticket sits*, and is structurally binary.

**Not `workType`** — Special is not a different kind of work.

**Not `failure_cycles.repeat_failure`** — that is REPEAT's counter; writing it would corrupt
`RepeatEscalationService`'s 3-in-7 threshold. REPEAT/ESCALATED mean *the SE fixed it and it broke
again*; Special means *the SE never worked it*. **Near-opposites.**

**Safest representations — both viable:**

| | Derived view | Stored attribute |
|---|---|---|
| Shape | Query over `batch_assignment_tickets` + `troubleshooting_submissions` + `tickets.status` | `tickets.attempt_count`, `tickets.special_since`, `tickets.special_reason` |
| Threshold change | Retroactive instantly | Only forward, unless backfilled |
| Cannot drift | ✅ | ❌ requires maintenance at dispatch + clearing on submit |
| Sortable by scheduler | ❌ | ✅ |
| Records *why* | ❌ | ✅ |
| Migration | None (one index) | Migration + backfill |

Decision 3 says the purpose is to **identify**. If Special never influences scheduling order, the
derived view is sufficient and strictly safer. → **Question 8**

---

## 7. Attempt Count Semantics — what is missing

Your rule: *the count starts where the ticket reaches the SE mobile workflow.*

| Field | Can it be defined today? | From what |
|---|---|---|
| `attempt_started_at` | **Partially** | `soft_states.set_at` where `type = 'VIEWED'` — **but only if the SE opened the ticket.** No signal exists for delivered-but-unopened |
| `attempt_ended_at` | **No — genuinely missing** | Nothing marks the end of an attempt. Candidates are all proxies: `soft_states.resolved_at` (`VIEWED_TIMEOUT` at 90 min, or `ADVANCED`), or day-plan closure — **which does not currently touch the ticket** |
| `attempt_success` | **Yes — reliable** | `troubleshooting_submissions` row exists for the ticket after `attempt_started_at` |
| `attempt_failure` | **Derivable only as a negation** | started ∧ ¬submitted ∧ still `OPEN`. Not positively recorded anywhere |

**What is missing, stated plainly rather than papered over:**

1. **No delivery receipt.** `GET /me/tickets` leaves no trace; the day-plan notification is
   schedule-level with no `entityType`/`entityId`; `device_tokens` is empty so push has never reached
   a handset. **A ticket that was dispatched and never opened is indistinguishable from one that was
   never delivered.**
2. **No attempt boundary object.** There is no `attempt` entity. `batch_assignment_tickets` is the
   closest — one row per dispatch, with `created_at` and `removed_at` — but it records the
   *assignment*, not the *field attempt*, and today `removed_at` is only ever set by a human.
3. **No negative outcome record.** Nothing writes "this attempt failed and here is why". The
   available proxies (`VIEWED_TIMEOUT`, stale-work warnings, VU reports, component-blocked) each
   cover a different subset.
4. **Offline sync window.** `writeQueue.ts` means a successful submission can arrive after the
   attempt looks failed.

**I am not inventing a synthetic definition.** The closest honest formulation the current system
supports is:

```text
attempt          := one batch_assignment_tickets row
attempt_reached  := a soft_states row (any type) exists for that ticket, set within the attempt window
attempt_success  := a troubleshooting_submissions row exists for that ticket
attempt_failed   := attempt_reached ∧ ¬attempt_success ∧ ticket.status = 'OPEN'
```

…and this counts **only attempts the SE actually opened** — which may be exactly what you meant, or
may exclude the most common failure. → **Question 2**

---

## 8. Return Date — complete flow

### Today

```text
Mobile: VehicleUnavailabilityFormScreen.tsx  (exists, wired)
  → POST /api/vehicle-unavailability { ticketId, seId, reasonCode, expectedFrom, expectedTo, … }
VehicleUnavailabilityService.fileReport()   — exactly three effects:
  1. INSERT vehicle_unavailability_reports (expectedFrom, expectedTo, reason, transporter, GPS)
  2. failure_cycle.slaPaused = true, slaPauseReason = 'VEHICLE_UNAVAILABLE'
        ── guarded by `if (cycle && !cycle.slaPaused)` — will NOT re-pause an
           already-paused cycle (e.g. WAITING_COMPONENT). Order-dependent.
  3. ticket.lastStateChangedAt = now

ticket.assignmentState   UNCHANGED (FORMALLY_ASSIGNED)
ticket.deferredUntil     UNCHANGED (NULL)
batch_assignment_tickets UNCHANGED (row stays live)
expectedFrom             READ BY NOTHING in any scheduling path
SLA resume               MANUAL ONLY — resumeSla() (ZM), which also sets report status RESOLVED
```

Grep confirms only two writers of `slaPaused: false` in the codebase:
`vehicle-unavailability.service.ts:200` and `component-request.service.ts:312`. **Nothing is
date-driven.**

### What would need to change

`fileReport()` would need to perform the same three writes `OverrideService.deferTicket()` already
performs together:

```text
ticket.deferredUntil   = expectedFrom
ticket.assignmentState = UNASSIGNED
batch_assignment_tickets.removed_at = now   (+ deferred_to_date = expectedFrom)
```

Then `notDeferredOn(istDate(now))` — already spread into the recommender, Shared Pool, intraday,
cross-zone and `isTicketReadableBySe` from **one shared definition** — makes the ticket re-enter the
selectable set on exactly the stated date (the predicate is `deferredUntil <= day`, i.e. **inclusive**
on the return date). **No new job or sweep is required for re-entry.**

Open consequences: SLA resume, report resolution, date changes → **Questions 5, 7, 9**.

---

## 9. Return-Date Priority (Option C) — safe implementation

### Current ordering, verified

`canonicalSort` (ADR-0017, pure comparator) — **Company Tier ↓ → Device Bucket ↓ → Company Priority
Rank ↑ → Oldest Inactive ↑ → Device ID ↑**. Its docstring states it is *"Enforced here as a
comparator; the live query mirrors it as a stable SQL ORDER BY."*

Selection is **not** score-based: `chosen = plannerBias ?? passed[0]`. `scoreCandidate()` output is
persisted for explainability only, and `distance` is inert.

`BUCKET_ORDER` = WARNING, EARLY_RISK, RISK, CRITICAL, HIGH_CRITICAL, SEVERE, VERY_SEVERE,
LONG_PENDING.

### Option C requires a rank strictly between "Critical+" and "normal backlog"

**Do not modify `sla_bucket`.** It is a stored enum on `device_states`, derived from `SLA_BANDS` via
`slaBucketCaseSql()` so SQL and TS cannot drift, and it feeds Fleet Uptime, the Soft Inactive Count
(which zones are *graded* on), SLA reporting and `dispatch_decision_traces`. Promoting a bucket to
express priority would corrupt every one of those.

**The safe shape: a new, explicit sort key evaluated *after* Device Bucket, gated to buckets below
CRITICAL.**

```text
compareCandidates(a, b):
  1. Company Tier               ↓            (unchanged)
  2. Device Bucket              ↓            (unchanged)
  ── NEW, only when both are below CRITICAL ──
  2b. returnDueToday            ↓            true before false
  3. Company Priority Rank      ↑            (unchanged)
  4. Oldest Inactive            ↑            (unchanged)
  5. Device ID                  ↑            (unchanged)
```

Because step 2 already ran, a CRITICAL+ ticket has been ordered ahead before 2b is consulted —
which is exactly Option C: **Critical/Severe → return-date → normal backlog**, with SLA severity
untouched.

`CRITICAL_PLUS` is already defined in `cross-zone-escalation.service.ts` as
`['CRITICAL','HIGH_CRITICAL','SEVERE','VERY_SEVERE','LONG_PENDING']` — reuse, do not re-spell.

### The comparator/SQL divergence risk is real and named in the codebase

`deferral.ts` exists precisely because six hand-written copies of a liveness filter drifted apart and
blanked every SE's day plan (#153). Any new sort term must land in **both** `canonical-sort.ts` and
the mirroring SQL `ORDER BY`, ideally projected from one source the way `slaBucketCaseSql()` projects
the bucket CASE from `SLA_BANDS`.

**`returnDueToday` must be a computable predicate, not a stored flag that can go stale** — e.g.
"an OPEN vehicle-unavailability report whose `expectedFrom` ≤ today", or `deferred_until = today`.
Which of those is authoritative depends on Question 7.

---

## 10. Return-Date Edge Cases

| Case | Behaviour under the design | Status |
|---|---|---|
| **Return today** | `notDeferredOn` is inclusive → selectable today; gets return-date rank | ✅ Determined. Caveat: if 05:00 already ran, it waits for tomorrow or a manual run |
| **Return tomorrow** | Excluded today, included tomorrow | ✅ Determined |
| **Return date changed** | Which value wins — the SE's latest report, or a ZM edit? Both write `expectedFrom` on *different* report rows; nothing reconciles them | ❓ **Question 7** |
| **Vehicle returns early** | **Nothing happens** — undetectable without vehicle location, which Decision 2 excludes. Ticket stays deferred to the stated date. Only a human (ZM `resumeSla`, or an override) can pull it forward | ✅ Determined — an accepted consequence of Decision 2, worth stating aloud |
| **Vehicle returns late** | Ticket returns on the stated date, is dispatched, SE finds it absent, files a **new** report with a new date. Self-correcting loop | ✅ Determined — **and this loop is what generates Special attempts** |
| **Vehicle never returns** | Loops indefinitely. Primary SLA paused each time; secondary SLA never pauses. Special is the intended catcher — but only if VU-terminated attempts count (Question 5) and there is a bound (Question 10) | ❓ |
| **Special + Return today** | Both are true simultaneously. Special (attribute) says *how it has behaved*; return-date says *when it may be scheduled*. They do not conflict structurally — but if Special ever gains a priority effect, precedence must be defined | ❓ **Question 9** |
| **Special + Critical/Severe** | Option C keeps return-date **below** CRITICAL+ by construction (step 2 runs first). If a returning ticket is *itself* CRITICAL+, it sorts by bucket and never consults 2b — correct | ✅ Determined |

---

## 11. SLA Analysis

| Question | Current code | Needs a decision? |
|---|---|---|
| Does SLA pause today? | **Yes** — primary only, `slaPauseReason = 'VEHICLE_UNAVAILABLE'`, guarded by `if (!cycle.slaPaused)` | — |
| Should it stay paused while waiting? | Not expressed anywhere | ❓ **Question 5** |
| Should it auto-resume on the return date? | **No such mechanism.** Only `resumeSla()` (manual, ZM) | ❓ **Question 5** |
| Does secondary SLA continue? | **Yes, always** — never pauses, manager-only via `secondarySlaSeconds` | ✅ No decision needed |
| Ticket returns to scheduler with primary SLA still paused? | **Would happen today.** The recommender does not read `slaPaused`, so a deferred-then-returned ticket is dispatchable with a frozen primary clock | ❓ **Question 5** |
| What happens to the VU report? | Stays `OPEN` indefinitely — `status = 'RESOLVED'` is written **only** by `resumeSla()` | ❓ **Question 5** |
| Who closes/resolves the report? | Only a ZM/CSM/OH, manually | ❓ **Question 5** |
| If the return date changes? | Report row can be edited; nothing propagates | ❓ **Question 7** |

**You asked me to stop and ask if a business decision is required here. It is — Question 5.**

---

## 12. Preview + Return Date + Special — interactions traced

**Scenario A — Special, return tomorrow, admin does nothing, 05:00 runs**

`deferred_until = tomorrow` → `notDeferredOn(today)` evaluates `tomorrow <= today` = **false** →
excluded from the recommender **and** from the SE's shared-pool view (`isTicketReadableBySe` applies
the same predicate). Special status is irrelevant today. Tomorrow it is selected and, being below
CRITICAL+, sorts above normal backlog. **Coherent — no conflict.**

**Scenario B — Special, return today, admin holds it, 05:00 runs**

Admin hold writes `deferred_until = tomorrow`, overwriting today's return date. The ticket is
excluded today. **The hold silently destroys the return-date information** — `deferred_until` is a
single column serving two purposes. The VU report still says `expectedFrom = today`, so the two
records now disagree. → this is why **Question 7** matters, and why a `returnDueToday` predicate
derived from the *report* rather than from `deferred_until` may be safer.

**Scenario C — Special, return today, admin manually reassigns**

`OverrideService.assignTicket()` / `assignPlants()` / `SPLIT_BATCH` — I checked each: **none consults
`notDeferredOn`**. `assignTicket` returns `ALREADY_ASSIGNED` if a live batch row exists, and otherwise
assigns. So **a manual override bypasses the deferral entirely.** It also bypasses `canonicalSort`, so
return-date priority is moot on that path.

This may be correct (ZM authority overrides policy) but it is currently **accidental rather than
decided** → **Question 11**.

---

## 13. End-to-End Simulation

Assumes Question 1 answered YES (recycling) and Question 2 answered "VIEWED counts". Threshold 3.

| Day | Event | State transitions (actual mechanisms) |
|---|---|---|
| **D0** | Device silent ≥ 48 h | `TicketCreationService` → `failure_cycle(OPEN)` + `ticket(OPEN, UNASSIGNED)` + `ticket_events(→OPEN)` |
| **D1 05:00** | Dispatch | recommender → `recommendations(SUGGESTED)`; `BatchAssignmentService` → `work_schedules(ACTIVE)` → `plant_batch_assignments` → `batch_assignment_tickets #1`; `assignmentState = FORMALLY_ASSIGNED`; `deferredUntil = NULL`; recs → `DISPATCHED`; `DAY_PLAN_DISPATCHED` notification (schedule-level) |
| **D1 day** | Mahesh opens the ticket, does not work it | mobile auto-posts `VIEWED` → `soft_states` row; expires at +90 min → `VIEWED_TIMEOUT` by `SYSTEM` |
| **D2 04:00** | Closure | schedule → `PARTIAL`. **NEW:** `batch_assignment_tickets #1.removed_at = now` (`removed_by` NULL = system); `assignmentState = UNASSIGNED`; **attempt 1 recorded failed** |
| **D2 05:00** | Re-dispatch | `batch_assignment_tickets #2`; `FORMALLY_ASSIGNED` |
| **D2 day** | Opened, not worked | `VIEWED` |
| **D3 04:00** | Closure | **attempt 2 failed**; back to `UNASSIGNED` |
| **D3 05:00** | Re-dispatch | `batch_assignment_tickets #3` |
| **D3 day** | Opened, not worked | `VIEWED` |
| **D4 04:00** | Closure | **attempt 3 failed → threshold 3 reached → SPECIAL** (derived, or `special_since` stamped) |
| **D4 day** | SE attends, vehicle absent, enters return = D5 | `vehicle_unavailability_reports(expectedFrom = D5)`; primary SLA **paused**; secondary keeps running. **NEW:** `deferredUntil = D5`, `assignmentState = UNASSIGNED`, batch row removed |
| **D4/D5 05:00 (D4)** | Excluded | `notDeferredOn(D4)`: `D5 <= D4` false |
| **D5 05:00** | Re-enters with return-date priority | selectable; `canonicalSort` step 2 orders CRITICAL+ ahead; among sub-CRITICAL, step 2b puts it above normal backlog. **Open:** does the primary SLA resume? Does the report resolve? → Question 5 |
| **D6** | Still not troubleshot | Closure records **attempt 4**. Already Special. **Open:** does the D4 VU-terminated attempt count as one of the 4? → Question 4/5. **Open:** is there any bound on repeating this? → Question 10 |

**Every transition above uses an existing mechanism except the three marked NEW**, all of which
belong to the single prerequisite in §4.

---

## 14. Contradictions Found

| # | Contradiction | Severity | Where |
|---|---|---|---|
| 1 | **Special requires repeated assignment; nothing re-assigns.** Threshold 3 is unreachable (max ever = 2, human-driven) | **Blocking** | §4 |
| 2 | **"Count from when it reaches the SE mobile" — no delivery signal exists.** Only "SE opened it" (`VIEWED`) is recorded | **Blocking** | §3.A |
| 3 | **`deferred_until` would serve two masters** — admin hold and return date — on one column. An admin hold silently overwrites a return date (Scenario B) | High | §12 |
| 4 | **Manual overrides bypass deferral.** `assignTicket`/`assignPlants`/`SPLIT_BATCH` never consult `notDeferredOn` | High | §12 |
| 5 | **VU pauses the primary SLA with no auto-resume.** A returned ticket would be dispatchable with a frozen clock and an `OPEN` report | High | §11 |
| 6 | **Stranded tickets are invisible to both sides.** `FORMALLY_ASSIGNED` (scheduler can't see it) + schedule not live (`liveScheduleFilter`) (SE can't see it) | High | §3.A |
| 7 | **Special vs REPEAT/ESCALATED are near-opposites** and would collide if they shared a field or vocabulary | Medium — avoidable | §6 |
| 8 | **Adding SPECIAL to `TicketStatus` breaks ≥6 consumers** | Medium — avoidable | §6 |
| 9 | **`resolveOnsiteSource` depends on `plants.location`**, which is NULL everywhere → `ON_SITE` evidence is always self-declared, never geofence-verified | Medium | §2.2 |
| 10 | **`fileReport` will not re-pause an already-paused cycle** (`if (!cycle.slaPaused)`). A component-blocked ticket that then hits vehicle-unavailable records the report but keeps the *component* pause reason | Medium | §8 |
| 11 | **Offline submissions can arrive after an attempt is judged failed** → false Special | Medium | §3.D case 7 |
| 12 | **`VEHICLE_ON_TRIP` hard filter is unreachable dead code** describing the *SE's* vehicle, not the truck | Low — latent | §2.2 |
| 13 | **Threshold 0 or 1 is technically settable and operationally destructive** (1 ⇒ 7,590 Special on day one) | Low — preventable by a validated ladder | §5 |

---

## 15. Performance / Data Integrity

| Risk | Assessment |
|---|---|
| **N+1 queries** | **Real risk** if Special is computed per ticket inside the recommender loop (~11,956 open tickets). Must be one batched aggregate per run, in the shape `committedDayLoad()` already uses |
| **Expensive assignment-history queries** | `batch_assignment_tickets` is indexed on `batch_id` only — **not `ticket_id`**. A per-ticket attempt count would seq-scan 15,092 rows repeatedly. An index on `ticket_id` would be required |
| **Scheduler slowdown** | Preview is a separate call; the dry-run path adds no load to the 05:00 run. Recycling adds bounded writes at 04:00 |
| **Duplicated attempt counting** | **Real risk.** If both closure and dispatch increment, an attempt is double-counted. A single writer is required. Deriving from `batch_assignment_tickets` avoids this entirely |
| **Race conditions** | Preview (reads `tickets`) vs 05:00 run (advisory lock on scheduling tables) do not contend. Closure at 04:00 and dispatch at 05:00 share the per-zone lock with the *try* variant — the closure skips rather than waits |
| **Duplicate attempts** | Prevented by `batch_assignment_tickets_one_active_per_ticket` (partial unique on `removed_at IS NULL`) and the `alreadyAssigned` guard |
| **Concurrent schedulers** | `pg_try_advisory_xact_lock` + `LOCK_CONTENDED` recorded on the zone row; `clearRunZoneOrphans(runId, zoneId)` cleans a rolled-back run's SUGGESTED recs without touching a concurrent run's |
| **Stale preview execution** | Solved pattern: HMAC token + 10-min TTL + `TOKEN_STALE` → fresh preview |
| **Incorrect attempt count** | The offline-sync window (case 7) is the main source. Also: recycling introduced without a backfill decision leaves 7,590 tickets at count 0 |
| **Double Special classification** | Impossible with a derived view. With a stored flag, `special_since` must be set once and cleared on submission — an easy omission |

**Idempotency verdict:** the existing guarantees (`SUGGESTED → DISPATCHED` consumption, per-zone
advisory lock, partial uniques, orphan cleanup, `alreadyAssigned`) are **preserved** by all four
decisions, **provided** attempt counting has exactly one writer and recycling is idempotent (stamping
`removed_at` twice must be a no-op).

---

## 16. Final Verdict

> ## YES, WITH CHANGES

**Decision 1 — works with modest changes.** The preview→token→`TOKEN_STALE`→execute pattern already
exists in `BulkUnassignService` with an admin page to match. The work is a dry-run seam on
`runForZone` and target-date parameters on three `now`-bound reads. Non-blocking coexistence with
05:00 is safe. Manual runs are unaffected. Pre-run *changes* beyond holds have nothing to attach to.

**Decision 2 — works as-is, zero code.** Nothing in the scheduler consumes location. Three pieces of
latent location-shaped code exist and are flagged, none of which contradicts the decision today.

**Decision 4 — works with changes, and every primitive exists.** `expectedFrom` is captured by a
shipping mobile screen; `deferredUntil` + `notDeferredOn()` is a complete, shared deferral engine;
`OverrideService.deferTicket()` already demonstrates the exact three-write pattern. Option C maps
cleanly onto a new sort key gated below CRITICAL+, without touching `sla_bucket`.

**Decision 3 — sound in principle, blocked in practice.** The detection rule is derivable and the
threshold pattern has an exemplary precedent (`assignment-threshold.ts`). But it depends on a
lifecycle behaviour that does not exist (§4) and on a signal that does not exist (§3.A). With the
system as it stands, `attempts >= 3` matches **zero** tickets, permanently, and "reached the SE
mobile" is unmeasurable — only "the SE opened it" is.

**Can all four work together?** Yes — the interactions are coherent and I found no unavoidable
contradiction. The thirteen issues in §14 are all either answerable by you or avoidable by
construction. The two blocking ones are both inside Decision 3.

---

# Questions Requiring Your Approval

**STOP.** No issues, slices, code, or migrations have been created. Eleven questions remain; **1 and
2 are hard blockers.**

---

### Q1 — Should an unresolved ticket automatically return to the pool when its day plan closes?

**Why it matters.** This is the prerequisite for Decision 3. Today a dispatched-but-unworked ticket
stays `FORMALLY_ASSIGNED` forever on a `PARTIAL` schedule — invisible to the scheduler *and* to the
SE. 7,590 live batch rows are in this state, and no ticket has ever been assigned three times. Without
this, **Special can never trigger**, and the return-date loop cannot repeat.

**Options.**
- **(a)** `ScheduleClosureScheduler` unassigns unresolved tickets at 04:00 — it already runs before
  dispatch, already holds the right per-zone lock, already computes the unresolved set
- **(b)** A separate sweep, to avoid widening the lock window the file's own docstring warns about
- **(c)** Only unassign tickets with *no* field activity (no `soft_states` row), leaving genuinely
  in-progress work assigned
- **(d)** Do not recycle — accept that Special never fires

**Recommendation (mine, not a decision).** **(a) with (c)'s guard**, in a short per-zone transaction:
it reuses the existing lock and unresolved-set computation, and the `soft_states` guard avoids
snatching back work an SE is mid-way through. The lock-widening concern is real and argues for
bounded, set-based writes rather than a per-ticket fan-out.

**Blocks.** All of Decision 3. Also the "vehicle never returns → eventually Special" path in
Decision 4.

---

### Q2 — What counts as "reached the SE mobile workflow"?

**Why it matters.** Your rule says the count starts there, and explicitly says not to assume a
recommendation or DB assignment means the SE received it. **I confirmed you are right — and it is
worse than that: no delivery signal exists at all.** `GET /me/tickets` leaves no trace; the day-plan
notification is schedule-level with no `entityType`/`entityId`; `device_tokens` has **0 rows**, so
push has never reached a handset. The only per-ticket signal is `soft_states.VIEWED`, auto-posted by
the mobile app when the SE **opens the ticket detail screen**.

**Options.**
- **(a)** `VIEWED` = reached. Honest and automatic, but **excludes the case where the SE never opened
  the ticket** — plausibly the most common failure, and one you may most want to catch
- **(b)** Dispatch = reached (`batch_assignment_tickets` row). Counts everything, but is exactly the
  assumption you told me not to make
- **(c)** Build a real delivery receipt (mobile ack on fetch, or per-ticket notification with
  `entityType='ticket'`) and count from that. Correct, but new work on both backend and mobile
- **(d)** Count both, in separate columns: `attempts_dispatched` and `attempts_reached`, and let the
  threshold apply to one while the other is diagnostic

**Recommendation (mine).** **(d) now, (c) later.** Counting both costs almost nothing (one is a row
count, the other a soft-state existence check), it keeps your stated rule honest, and it makes the
"assigned but never opened" population *visible* — which is itself an operationally important finding
rather than something to hide inside a threshold.

**Blocks.** The definition of `attempt_started_at`, the Special rule, and cases 1 and 2 in §3.D.

---

### Q3 — What happens to the 7,590 already-stranded tickets when recycling is switched on?

**Why it matters.** They would all return to `UNASSIGNED` at once, against ~375 recommendations per
run and 5,000+ `OVER_CAPACITY` drops. That is a queue flood on day one.

**Options.** (a) Release all at once. (b) Release gradually (N per zone per day). (c) Leave the
existing 7,590 stranded and apply recycling only to newly-closed plans. (d) Bulk-close them as a
one-off data remediation first.

**Recommendation (mine).** **(b) or (c).** (c) is the cleanest to reason about — a clear "from this
date forward" boundary — but leaves 7,590 tickets permanently invisible, which is its own problem and
would need a separate remediation decision.

**Blocks.** Safe rollout of Q1.

---

### Q4 — Do ZM-withdrawn and manually-deferred assignments count as unsuccessful attempts?

**Why it matters.** Cases 8 and 9. There is a **strong existing code precedent**:
`ScheduleClosureScheduler` states *"removed tickets (`removedAt`) are a ZM's withdrawal, not
unfinished work, so they never hold a day open."* The data can distinguish them —
`removed_by IS NOT NULL` means a human withdrew it.

**Options.** (a) Do not count withdrawals or defers (follows precedent). (b) Count them. (c) Count
withdrawals but not defers.

**Recommendation (mine).** **(a)** — consistent with an explicit decision the codebase has already
made about the same column, and it avoids penalising a ticket for a manager's rebalancing.

**Blocks.** The attempt-counting rule.

---

### Q5 — SLA and report lifecycle on the return date *(you asked me to stop here — this is that point)*

**Why it matters.** Filing a VU report pauses the **primary** SLA and nothing resumes it except a
manual ZM action, which also resolves the report. If the ticket auto-returns on `expectedFrom`, it
becomes dispatchable **with a frozen primary clock and an `OPEN` report**. The secondary clock never
pauses, so true elapsed time is always visible to managers.

Four coupled sub-questions:
1. Does the primary SLA auto-resume on the return date?
2. Does the VU report auto-resolve, or stay open until a human closes it?
3. Does a VU-terminated attempt count toward Special? *(This decides whether a never-returning vehicle
   eventually becomes Special — §10 says you want it "eventually handled".)*
4. If the SE attends and the vehicle is absent again, is that a new attempt and a new report?

**Recommendation (mine).** Resume the primary SLA when the ticket re-enters scheduling (otherwise the
clock is dishonest); **auto-resolve the report only when a new one supersedes it or the ticket is
submitted** (auto-resolving on a date asserts a return nobody observed — and Decision 2 means we
cannot observe it); **yes, count VU-terminated attempts**, since that is what makes a never-returning
vehicle surface as Special.

**Blocks.** Decision 4's SLA behaviour and part of Decision 3's counting rule.

---

### Q6 — How is the offline-submission window handled?

**Why it matters.** `apps/mobile/src/api/writeQueue.ts` queues writes offline. A successful
troubleshoot submitted in the field can arrive hours later. If an attempt is judged failed at 04:00
closure, a genuinely successful visit can be counted as a failure — and at threshold 3 that can
manufacture a false Special.

**Options.** (a) Grace period before an attempt is judged (e.g. 24 h). (b) Evaluate Special lazily at
read time, so a late submission retroactively corrects it. (c) Accept the risk.

**Recommendation (mine).** **(b)** — and it falls out for free if Special is a derived view (Q8),
because a late submission simply makes the predicate false.

**Blocks.** Attempt-outcome timing; interacts with Q8.

---

### Q7 — When the return date changes, which value wins?

**Why it matters.** The SE can file a new report; a ZM can edit the date on an existing one. Both
write `expectedFrom`, on different rows. Nothing reconciles them. And if `deferred_until` is the
scheduling trigger, an **admin hold overwrites the return date silently** (Scenario B, §12) — one
column serving two purposes.

**Options.** (a) Latest report wins. (b) ZM edit outranks SE entry. (c) Earliest date wins. (d) Keep
`deferred_until` as the hold, and derive `returnDueToday` from the **report** instead — so the two
never collide.

**Recommendation (mine).** **(a) + (d).** Deriving return-due from the VU report keeps admin holds and
return dates independent, which removes contradiction #3 entirely.

**Blocks.** The `returnDueToday` predicate in §9 and the Decision 1 hold semantics.

---

### Q8 — Is Special a derived view or a stored attribute?

**Why it matters.** It decides whether changing the threshold reclassifies existing tickets, whether
Special can be sorted on, and whether it can drift. **Code-determined:** it cannot be a `TicketStatus`
value.

**Options.** (a) Derived query — no migration, retroactive, cannot drift, but not sortable and records
no reason. (b) Stored `attempt_count` + `special_since` + `special_reason` — sortable and explanatory,
but must be maintained and cleared.

**Recommendation (mine).** **(a) derived**, because Decision 3 states the purpose is to *identify*. It
also solves Q6 for free. Move to (b) only if Special later needs to influence scheduling order.

**Blocks.** Data-model shape; interacts with Q6 and Q9.

---

### Q9 — Does Special affect scheduling priority, or is it identification only?

**Why it matters.** Decision 3 says "identify". Decision 4 gives return-date tickets a priority rank.
If Special also carries priority, their precedence must be defined — and Special becomes sortable,
forcing Q8 to (b).

**Options.** (a) Identification only (admin visibility). (b) Special ranks above normal backlog,
below return-date. (c) Special ranks above return-date. (d) Special is *de*-prioritised — it has
already failed three times.

**Recommendation (mine).** **(a)** for now. It matches your stated purpose, keeps `canonicalSort` to
one new term instead of two, and lets you learn what Special actually contains before letting it move
work.

**Blocks.** Q8's shape; the number of new sort keys in §9.

---

### Q10 — Is there a bound on deferrals or on how far out a return date may be set?

**Why it matters.** Nothing bounds either today. A vehicle that never returns loops indefinitely
(dispatch → VU → defer → dispatch), with the primary SLA paused each cycle. Only the secondary clock
keeps running, and it is manager-only.

**Options.** (a) Max N days out on `expectedFrom`. (b) Max N consecutive VU deferrals before
escalation. (c) Both. (d) Neither — rely on Special.

**Recommendation (mine).** **(c)**, with Special as the surfacing mechanism rather than the only
guard. Relying on Special alone means the loop is bounded only by a threshold that is itself
configurable and may be set high.

**Blocks.** Decision 4's "vehicle never returns" path.

---

### Q11 — Should a manual override be able to assign a deferred ticket, and what may Admin change in preview?

**Why it matters.** Two halves of one gap.
`OverrideService.assignTicket()` / `assignPlants()` / `SPLIT_BATCH` **do not consult `notDeferredOn`**
— a ZM can assign a ticket that is deferred to a future return date, bypassing both the hold and the
priority logic. This is currently accidental, not decided.
Separately, "Admin can change the plan" has **nothing to attach to** before dispatch — no batch
exists. Only a hold (`deferred_until`) is expressible today.

**Options — bypass.** (a) Keep the bypass (ZM authority outranks policy). (b) Block it. (c) Allow with
an explicit confirm + reason, following the existing `confirm?: boolean` pattern on override commands.

**Options — pre-run change.** (i) Holds only. (ii) Holds + SE pre-assignment (needs a new
pre-assignment table). (iii) Holds + `se_planner` rows (soft bias only, not binding).

**Recommendation (mine).** **(c)** for the bypass — the override commands already carry a
`reasonCode` and a `confirm` flag, so this fits the existing shape. **(i)** for pre-run change, at
least initially: it needs no new persistence and delivers Decision 1's stated behaviour in full.

**Blocks.** Decision 1's "change" scope; Scenario C in §12.

---

**Awaiting your answers. Nothing further will be created until you approve.**

---

*Analysis only. No application code, database schema, migration, issue, slice, production data, or
AutoPlant data was modified.*
