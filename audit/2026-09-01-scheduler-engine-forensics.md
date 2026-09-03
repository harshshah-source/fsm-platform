# Scheduler Engine Forensics — 2026-09-01

**Read-only forensic investigation of the Scheduler Engine, end-to-end:** ingestion →
validation/normalization → models/DB → capacity & eligibility → scheduler → decisions/assignments →
dispatch run → API → frontend → user mutations → next scheduler run.

- **Branch:** `feat/autoplant-integration` (working tree at investigation time; line numbers reference it).
- **Method:** five parallel read-only investigation agents (ingestion, scheduler core, mutations/API,
  admin frontend, cross-cutting schema/concurrency/tests), each verifying against code as the source
  of truth; docs used only as intended-behavior context. No code, DB, schema, tests, config or UI
  was modified.
- **Point-in-time audit** — this document is frozen once written (per the `audit/` convention);
  corrections go to INDEX/SYSTEM-STATE, not here.
- Shareable rendered version: https://claude.ai/code/artifact/c67ea322-02df-41c7-b4f3-c0796fdeff27

**Overall verdict:** no P0s and no path to unrecoverable data corruption. The dispatch core —
DB-backed zone claims, per-SE `FOR UPDATE SKIP LOCKED` transactions, three partial uniques,
heartbeat/reaper/recovery lattice, guarded `updateMany` finalizes — is unusually disciplined, and
double assignment is impossible at the DB. The defects cluster at the **seams** that discipline
doesn't reach: modules that predate the guarded-write idiom (verification, auto-recovery),
duplicated business vocabularies, the escalation ledger's lifecycle, ingestion's poison-row blast
radius, and the one legacy UI page the console was supposed to absorb.

**Severity tally:** 4 × P1 · ~19 × P2 · 30+ × P3 · 0 × P0.

Backend paths below are relative to `apps/backend/src/`, frontend paths to `apps/admin/src/`,
unless stated otherwise.

---

## 1. Architecture / data-flow map

```
AutoPlant MySQL (VPN, read-only; latest-state tb_vehiclemaster + masters)
  │ masters daily 02:00 · telemetry */30      [IntegrationSchedulerService, env-gated]
  ▼
INGESTION  snapshot-ingestion.worker.ts — keyset scan (ORDER BY device_id LIMIT 90,
  │        full re-scan every run) → normalize (UTC offset 0, skew guard) →
  │        raw_device_snapshots (createMany skipDuplicates, daily UTC partitions)
  │        + device_states watermark upsert (GREATEST / COALESCE)
  │        run ledger: snapshot_runs (advisory lock + partial unique RUNNING,
  │        heartbeat, 30-min stale-run reaper)
  ▼  #230 gate: downstream runs ONLY on run status SUCCESS
DERIVE     device-state.service.ts — set-based recompute: inactivity_hours,
  │        is_inactive, sla_bucket, eligibility  →  auto-recovery pre-check
  ▼
TICKETS    ticket-creation.service.ts — silent ≥ threshold + eligible + no open
  │        cycle → one tx: failure_cycle + ticket (OPEN) + event + flag
  │        (I1 partial unique failure_cycles_one_active_per_device backstop)
  ▼
RECOMMEND  recommender.service.ts (per zone) — universe: OPEN+UNASSIGNED+TROUBLESHOOT,
  │        not deferred/blocked/departed/deactivated → canonicalSort → per ticket:
  │        candidates (DEDICATED→MULTI_PLANT→FLOATING w/ live re-validation)
  │        → buildCandidateReadiness → applyHardFilters → chooseWithinTier + score
  │        → recommendations SUGGESTED | UNASSIGNABLE + dispatch_decision_traces
  ▼
DISPATCH   dispatch-run.service.ts — admission: dispatch_runs + per-zone claim rows
  │        (ux_dispatch_run_zones_one_running_per_zone), CRON patient / MANUAL not,
  │        heartbeat + 10-min reaper (→ABORTED) + same-day bounded recovery (#286)
  │        batch-assignment.service.ts — ONE TX PER SE: advisory zone lock (3s) →
  │        FOR UPDATE SKIP LOCKED claim of SUGGESTED → work_schedules append-or-
  │        create (liveScheduleFilter ACTIVE+OVERRIDDEN) → plant_batch_assignments
  │        → batch_assignment_tickets (one_active_per_ticket) → ticket
  │        FORMALLY_ASSIGNED → recs DISPATCHED → outbox row; post-commit drain
  ▼
API        schedules / batches / dispatch-today / dispatch-runs / intraday
  │        controllers (AuthGuard + RoleGuard + zone scope; acting-zone partial)
  ▼
ADMIN UI   Scheduler Console (TodaysDispatchPage): one lifted GET /dispatch/today,
  │        no react-query, no polling, pessimistic writes → invalidate() refetch;
  │        day columns via useDayContext (schedules?date, preview, card-summaries)
  ▼
MUTATIONS  assign / assign-batch / override (7 actions) / holds / bulk-unassign /
  │        intraday manual-assign — partial uniques + guarded terminal stamps
  ▼
NEXT RUN   engine only plans OPEN+UNASSIGNED ⇒ manual work survives; dispatch
           APPENDS to live schedules; 04:00 IST closure recycles unresolved
           rows (PLAN_EXPIRED → ticket UNASSIGNED)
```

### Source of truth per concept

| Concept | Owning table | Duplicate prevention |
|---|---|---|
| Ticket + status | `tickets` (enum) | `@@unique(failureCycleId)`; TROUBLESHOOT⇒cycle CHECK |
| Failure episode | `failure_cycles` | partial unique one-active-per-device (I1) |
| Live assignment | `batch_assignment_tickets` (`removed_at IS NULL`) | partial unique one-active-per-ticket |
| Day plan | `work_schedules` | partial unique per (SE, zone, day) — **ACTIVE only** (AR-8) |
| Live recommendation | `recommendations` (TEXT status) | partial unique one-SUGGESTED-per-ticket |
| Run + zone ownership | `dispatch_runs` + `dispatch_run_zones` | partial unique one-RUNNING-per-zone; heartbeat + reaper |
| Crashed-zone debt | `dispatch_zone_recoveries` | unique (zone, businessDate) |
| Cron single-fire | `cron_tick_claims` | PK (job, UTC minute) — insert is the test, **no reclaim** (RC-3) |
| Escalation / intraday | `intraday_insertions` | query-level dedup only for ESCALATION_REQUIRED |
| Capacity | derived: `committedDayLoad` over live batch rows | one definition, shared engine ↔ console (#269/#274) |
| Notification intent | `day_plan_notification_outbox` | guarded `sentAt IS NULL` claim |

Concurrency machinery: partial uniques above; per-zone advisory xact lock (`dispatch-zone-lock.ts`,
blocking, 3 s `lock_timeout`, guards dispatch vs closure/bulk-unassign); DB zone claim
(`zone-claim.ts`); guarded terminal stamps (`common/lost-race.ts` `stampOnceOrLose`); P2002
recovery (`common/unique-violation.ts` — `meta.target` does not exist under this driver adapter,
`modelName` is the discriminator); `FOR UPDATE SKIP LOCKED` in `assignLane` and the dispatch claim.
**No version columns / optimistic locking anywhere** — correctness rests on partial uniques plus
guarded-predicate updates.

---

## 2. Key components + responsibilities

| Component | Responsibility |
|---|---|
| `ingestion/snapshot-ingestion.worker.ts` | Chunked telemetry pull, 3× retry, run ledger, PARTIAL/FAILED finalization |
| `ingestion/normalize.ts` + `ingestion/autoplant/mapping.ts` | UTC normalization (offset 0 post-#222), two-directional skew guard; **throws** on unparseable GPS (AR-1) |
| `device-state/device-state.service.ts` | Set-based recompute of inactivity/SLA/eligibility; never-reported aging |
| `ticketing/ticket-creation.service.ts` | Per-device tx creating cycle+ticket+event+flag; I1 backstop |
| `ticketing/auto-recovery.service.ts` | Closes tickets of now-healthy devices — **unguarded ticket write** (RC-2) |
| `recommender/*` | Candidate pool, readiness (one function, shared with console), hard filters, tier chooser, scoring, canonical sort, decision traces |
| `scheduling/dispatch-run.service.ts` | Run admission/claims/patience/reaper/recovery; per-zone orchestration |
| `scheduling/batch-assignment.service.ts` | Per-SE dispatch transactions; append semantics; idempotency |
| `scheduling/override.service.ts` | Every manual door: assign / assignLane / 7 override actions / moveTickets; lost-race hygiene (#265) |
| `scheduling/scheduler-preview.service.ts` | Dry-run preview + holds (holds write is TOCTOU — RC-6) |
| `scheduling/schedule-closure-scheduler.service.ts` | 04:00 IST closure; recycles unresolved rows PLAN_EXPIRED |
| `intraday/intraday-insertion.service.ts` | CRITICAL direct-assign sweep (2 min) or ESCALATION_REQUIRED |
| `scheduling/cron-tick-claim.service.ts` | Cross-instance tick arbitration on UTC minute |
| admin `pages/dispatch/console/useConsoleData.ts`, `useDayContext.ts` | The console's entire cache: one lifted fetch + version-keyed day columns |
| admin `pages/dispatch/console/dropTargets.ts`, `ActionsBand.tsx` | One drag-legality predicate; all mutation forms + preview |

Mutation doors (all under AuthGuard+RoleGuard, manager roles):
`POST /schedules/assign` → `OverrideService.assignTicket`; `POST /schedules/assign-plants` and
`/assign-batch` → `assignLane` (one tx per engineer lane, per-ticket `FOR UPDATE SKIP LOCKED`
re-verify, itemised skips); `POST /batches/:id/override` (REMOVE/DEFER/REORDER/SWAP_SE/REASSIGN/
SPLIT_BATCH/MOVE_TICKET) → `OverrideService.override`; `POST /batches/:id/override/preview`
(writes nothing — verified); `POST /intraday-updates/{add,remove,reorder}` → `SameDayUpdateService`;
`POST /intraday-insertions/fire`, `:id/manual-assign`; `POST /schedules/holds`, `holds/release`;
`POST /schedules/bulk-unassign` (OH-only, zone-claim-aware, advisory-locked, signed Pan-India
token); `POST /schedules/dispatch-run`; `PUT /schedules/dispatch-schedule`.

---

## 3. End-to-end ticket lifecycle (five traced flows)

### 3.1 Normal assigned ticket
Device ping → `telemetryTick` (`integration-scheduler.service.ts:77`, tick claim :83) →
`ingestTelemetry` → snapshot chunk (`readChunk` → `mapVehicleMasterRow` → `normalizeSourceRow` →
`rawDeviceSnapshot.createMany skipDuplicates` → `device_states` GREATEST/COALESCE upsert) → run
SUCCESS → recompute marks inactive (`device-state.service.ts:71-236`) →
`createForInactiveEligible` (`ticket-creation.service.ts:43-154`): one tx per device — cycle +
ticket OPEN (`ticket_no` from a Postgres sequence — no race) + event + flag, I1 P2002 → skip →
05:00 IST run: recommender selects (`recommender.service.ts:326-397` universe; `canonicalSort`
:472; capacity seed from `committedDayPlan` :504-511; per ticket: candidates :593 → readiness
:617-626 → `applyHardFilters` :630 → `chooseWithinTier` :662-666 with per-candidate cluster
multiplier :646-647) → `recommendation.create` SUGGESTED :779-801 + decision trace → dispatch
(`batch-assignment.service.ts:147-306`): per-SE tx — advisory lock :161, SKIP-LOCKED claim
:168-175, already-assigned re-read :182-190, schedule append-or-create :214-235, batch-ticket row
with AUTO_DISPATCH provenance :262-276, ticket → FORMALLY_ASSIGNED :279-284, recs → DISPATCHED
:299-302, outbox :292 → zone claim DONE, run SUCCESS, post-commit outbox drain →
`GET /dispatch/today` renders it.

### 3.2 Unassigned / escalated ticket
Same path to selection; empty pool or all candidates dropped → `chosen === null`
(`recommender.service.ts:679`) → `recommendation.create` `status:'UNASSIGNABLE', seId:null` with
`poolEmptyReason` NO_COVERAGE/ALL_DROPPED :680-704 — never silently dropped (sole exception: a
bucketless device is counted, not recorded, :434-439). Kit drops feed the Component-Blocked queue
(:736-740). Ticket stays OPEN+UNASSIGNED and re-enters every run; Platinum unassigned 1 h
CRITICAL / 4 h OPEN auto-escalates cross-zone (`business-cross-zone` sweep). CRITICAL bucket: the
2-minute `business-critical-assign` sweep direct-assigns via the same `chooseWithinTier`, or writes
`intraday_insertions` ESCALATION_REQUIRED → red strip on the console — **whose Assign door never
clears the row (CB-2)**.

### 3.3 Manual assignment
`POST /schedules/assign` (`schedules.controller.ts:415-450`) → `assignTicket`
(`override.service.ts:493-674`): zone scope :528, ALREADY_ASSIGNED pre-check :530, deferral gate
409+confirm :548-580 → one tx :589-659: `ensureSchedule` :1196 (find live else create ZM_MANUAL) →
batch find-or-create → batch-ticket with `add_source`/`added_by`/`coverage_type_at_assign` (#283)
→ ticket FORMALLY_ASSIGNED + `deferredUntil:null` :649 → audit + outbox. Race recovery :661-670
(schedule race retried once; batch-ticket P2002 → 409). **Next run leaves it alone** (engine plans
only UNASSIGNED) and appends around it. No capacity/eligibility gate — by design (#258 Q2:
administrative right; capacity is surfaced, never gated).

### 3.4 Future-date movement
`MOVE_TICKET` (`batches.controller.ts:114`; past target → 400 :161-168) → `moveTickets`
(`override.service.ts:1038-1183`), one tx: ensure target-day schedule :1077, destination batch
OVERRIDDEN :1088, source rows terminal-stamped REASSIGNED **guarded on `removedAt:null`** (a lost
row rolls back the whole move) :1111-1121, destination rows MANUAL_DAY_MOVE :1122-1138, source
schedule flipped OVERRIDDEN under `liveScheduleFilter` (closed days never resurrected) :1140, open
ESCALATION_REQUIRED rows closed ACCEPTED :1149-1152 (#288). Never UNASSIGNED in between;
`deferred_until` deliberately preserved. IST `@db.Date` math correct; 04:00 closure
(`dateTo < today`) skips the future plan; the target day's run appends to it.

### 3.5 Adjusted (operator-modified) ticket
REORDER/DEFER/REMOVE flip the schedule to OVERRIDDEN (provenance; still live per #153's
`LIVE_SCHEDULE_STATUSES`). A later same-day run finds the OVERRIDDEN schedule (both `dispatchForSe`
and `ensureSchedule` use `liveScheduleFilter()`) and **appends** after `max(stop_sequence)` — the
operator's ordering survives; nothing is rewritten. DEFER: batch row terminal ZM_DEFERRED, ticket
UNASSIGNED + `deferred_until`; returns exactly on its date; dispatch clears the deferral on
re-dispatch. REMOVE: ticket UNASSIGNED with **no cool-down** — a Run-now minutes later may
legitimately re-assign it to the same SE. The adjustment is destroyed only by OH bulk-unassign,
the 04:00 closure, or ticket resolution — the scheduler itself never removes or reorders operator
work.

---

## 4. Scheduler lifecycle

- **Trigger:** `@Cron(…, timeZone:'Asia/Kolkata')` (`dispatch-scheduler.service.ts:84`); the live
  expression is `system_settings.dispatch_cron`, re-pointed at boot and on write
  (`dispatch-schedule.service.ts:75-146`). Manual `POST /schedules/dispatch-run` shares
  `runForActiveZones` exactly. Tick claimed cross-instance on the UTC minute
  (`cron-tick-claim.service.ts:51-71`).
- **Admission:** one tx (`dispatch-run.service.ts:343-425`): run row RUNNING + per-zone claim rows
  via `INSERT … ON CONFLICT DO NOTHING` against `ux_dispatch_run_zones_one_running_per_zone`;
  held zone → CONTENDED row naming the holder; all-held → whole rollback, 409, zero rows. Claims
  in ascending zone id (no deadlock). Future-day dispatch refused beyond 15-min skew :241-247.
- **Patience (#260):** CRON runs retry at admission and per contended zone (60 s ×
  15 min deadline, beat-while-waiting; CONTENDED promoted in place via guarded UPDATE);
  MANUAL never waits; recovery re-dispatch never waits (`deadlineMs: 0`).
- **Execution:** per zone → recommender → per-SE dispatch tx. One SE's failure costs one SE
  (`se_skips` named, `SCHEDULE_CONFLICT` earned by the unique alone); that SE's leftover
  SUGGESTED rows are RETIRED, not deleted (traces survive).
- **Crash lattice (#261/#286):** heartbeat at admission + after every zone; reaper (pre-admission
  + 3-min cron) marks silent RUNNING runs ABORTED and orphan claims ERROR **by predicate** (an
  earlier crashed pass's leftovers are finished by the next); recovery marks
  (`dispatch_zone_recoveries`, one per zone/day) written **before** claims are freed; 5-min
  collector re-dispatches with no privileges, 3 attempts/day, 18:00 IST cutoff, EXHAUSTED/EXPIRED
  sticky and surfaced on `/dispatch/today`. Reap (10 min) ≤ retry deadline (15 min) is a stated
  invariant. All finalizes are status-guarded `updateMany` — a reaped-but-alive run cannot
  overwrite ABORTED with SUCCESS.
- **Status lifecycles (as written):** DispatchRun `RUNNING → SUCCESS | PARTIAL | FAILED | ABORTED`
  (terminal, no way back). Claim `RUNNING → DONE | ERROR`; `CONTENDED` promotable. Recommendation
  `SUGGESTED → DISPATCHED | RETIRED`; `UNASSIGNABLE` terminal. WorkSchedule
  `ACTIVE → OVERRIDDEN → COMPLETED | PARTIAL`. Recovery `PENDING → RECOVERED (re-armable) |
  EXHAUSTED | EXPIRED (sticky)`. Ticket `UNASSIGNED ↔ FORMALLY_ASSIGNED`, flips guarded on "no
  live batch row left".
- **Eligibility (the real filters):** candidate pool per plant = `se_coverage` DEDICATED →
  MULTI_PLANT → FLOATING from the `plant_eligible_floating_se` MV **re-validated live**. Hard
  filters in drop-precedence order: `VEHICLE_ON_TRIP` (**stub, NOT_ENFORCED** — Issue 28 seam),
  `SE_UNAVAILABLE` (real: `is_active` + `se_availability` window; leave approval writes a window),
  `OVER_CAPACITY` (real: `committed >= dailyCapacity`), `COMMON_KIT_INCOMPLETE` (real),
  `COMPONENT_UNAVAILABLE` (**stub** — Issue 22 seam). **No skills filter exists** (eligibility is
  coverage-based only); home-base distance is scoring-only, never a filter (#267). Filters and
  scoring cannot disagree on readiness: engine, Assign Console, candidate column and Distribute
  all consume the same `buildCandidateReadiness` + `applyHardFilters` + `committedDayLoad`.
- **Capacity:** one definition (`committed-day-load.ts:40-110`) — live batch rows on live
  schedules covering the IST day, all zones, all runs; `>=` boundary at both filter and display;
  held/removed rows free capacity; dispatch itself never re-checks (enforcement lives at
  recommendation time). See RC-4 for the concurrency hole.
- **Gaps in the lattice:** the crash window between tick-claim and admission is the one
  unrecovered point (RC-3); a single zone silent >10 min self-reaps while alive (RC-5); zones
  lost to contained in-process errors get no same-day recovery (AR-13).

---

## 5. Frontend / backend flow

- **No query library, no polling, no optimistic state.** One lifted `GET /dispatch/today` (+
  changes ledger) in `useConsoleData.ts` with a request-sequence counter for stale-response
  discard; every mutation is pessimistic write → `invalidate()` → refetch; a `version` bump drops
  the whole `useDayContext` day-column cache.
- **Drag never commits.** One shared legality predicate (`dropTargets.ts:77-96`: ticket→today =
  REASSIGN, ticket→future = MOVE_TICKET, pool→today = ASSIGN, stop→today = SWAP_SE); a drop only
  opens the Inspector seeded with the intent; commit happens in the dialog with mandatory reason;
  409 conflicts (ON_SITE / CONFLICT_DEFERRED) become a second confirm gate. Double-drop and
  double-submit are guarded.
- **Day semantics are server-owned** (`operatingDay = istDate(now)`); `dayAxis.ts` does pure UTC
  calendar math over IST date strings. Residual: a console open across IST midnight keeps calling
  yesterday "TODAY" until the next invalidation.
- **Contract parity is largely verified field-for-field** (`DispatchTodayView`, `TodayTicket`,
  `OverrideCommand`, both 409 shapes, hold refusals, zoneId string coercion). The drift surface is
  ~9 re-spelled string enums with no shared package (AR-10), mostly defensively consumed.
- **Weak seams:** post-write refetch failure blanks the whole console (AR-6); every write can
  refire pan-India reads plus the national dry-run recommender (AR-5); the legacy
  ScheduleDetailPage still carries a full second copy of the override controls and fails silently
  (CB-7 / AR-4).

---

## 6. Confirmed bugs

### CB-1 — P1 — SE work-history chart collapses to ~0 completed as work completes
- **Where:** `me-tickets/me-work-history.service.ts:87` vs `scheduling/close-assignment.ts:42-45`.
- **Path:** since #178 every terminal closure stamps the batch row (`removedAt`, reason
  `TICKET_RESOLVED`) inside the closing tx (called from verification close/fail, auto-recovery,
  install, recovery, non-op). The history read builds `assigned(D)` from `removedAt: null` and
  only counts a completion if the ticket is in that set — so completed work vanishes from **both**
  series, retroactively (`closure-assignment-backfill.ts` stamped history too).
- **Masked by:** `test/me-work-history.e2e-spec.ts:88-89` fabricates closures with a bare
  `ticketEvent.create` — a state production can no longer produce.
- **Expected:** per the module's own docblock, `TICKET_RESOLVED`/`AUTO_RECOVERY` removals are
  finished work; only human withdrawals should be excluded (the sibling live read,
  `me-tickets-query.service.ts:67`, already compensates).
- **Impact:** the SE mobile Home chart shows completed ≈ 0 and assigned shrinking. Display-only,
  but it is the SE's productivity view.

### CB-2 — P1 — Console's Assign door never clears an ESCALATION_REQUIRED row (cross-layer)
- **Where:** `scheduling/override.service.ts:493` (`assignTicket`) vs
  `scheduling/dispatch-today-query.service.ts:861` (`escalationsOpen`) vs
  `pages/dispatch/TodaysDispatchPage.tsx:585-667` (red strip).
- **Path:** the strip's "Assign this work →" resolves (per `placementOf`) to
  `POST /schedules/assign`, which never touches `intraday_insertions`; only `moveTickets`
  (:1149-1152) and the intraday queue's own `manual-assign` close the row, and `escalationsOpen`
  filters only on `status: 'ESCALATION_REQUIRED'`, not on the ticket still being unassigned.
- **Impact:** the operator resolves the escalation exactly as the UI instructs and the row comes
  back on refetch — "N critical tickets need manual assignment" and `criticalNeedsYou` stay
  inflated indefinitely (the row now reads "Reassign this work →"). Every component individually
  looks correct; the composed flow is wrong.

### CB-3 — P2 — Batch override accepts an empty mandatory reason (and 500s on missing fields)
- **Where:** `scheduling/batches.controller.ts:114-170`; `app.module.ts:225-229`;
  `override.service.ts:355, 1267-1268`.
- **Path:** the body is an interface, the global pipe skips interface-typed bodies, and the
  service writes `cmd.reasonCode` through unchecked — NULL reason on the one surface whose
  contract ("mandatory reason") and sibling door (`intraday-updates.controller.ts:82,102`
  correctly 400s) both promise enforcement. Missing `ticketId` → Prisma error 500.
- **Impact:** the accountability record #275/#282 build on can silently be empty.

### CB-4 — P2 — Override preview reports no ON_SITE conflict; the identical commit 409s
- **Where:** `scheduling/override-projection.service.ts:293-303`.
- **Path:** `conflictsFor` hardcodes `onSite: []` on the stale premise that `soft_states` "does
  not exist yet" — the real port (`soft-state/soft-state-conflict.adapter.ts`) is implemented and
  bound in the same module (`scheduling.module.ts:98`), and the commit path gates on it
  (`override.service.ts:235-251`).
- **Impact:** exact preview/commit drift the service's own docblock calls "worse than no preview".

### CB-5 — P2 — Four divergent terminal-status vocabularies; departure re-closes terminal tickets
- **Where:** `device-departure/device-departure.service.ts:36-41, 255-296`;
  `plant-deactivation/plant-deactivation.service.ts:20-25`;
  `exports/entity-mapping-export.service.ts:17`; canonical:
  `ticketing/resolved-ticket-status.ts:19` (7 members).
- **Path:** departure/deactivation use a 4-member copy and their close writes carry **no status
  guard** — a ticket already terminal at `FAILED_ACTIVATION` or `RECEIVED_AT_WAREHOUSE` is
  re-closed as `CLOSED / DEVICE_UNDEPLOYED_CLOSE`, its `closureType`/`closedAt` overwritten, a
  second closure event appended. The export's 4-member `CLOSED_TICKET_STATUSES` makes
  `openTicketCount` count three terminal statuses as open.
- **Impact:** rewritten history; double-counted closures in reports; wrong export counts.

### CB-6 — P2 — Day navigation strands console columns in "loading" forever
- **Where:** admin `pages/dispatch/console/useDayContext.ts:121-184`.
- **Path:** the counts/projection effect keeps a per-run `live` flag cleared on every
  day-navigation while the `requested` set survives — an in-flight response is discarded and never
  re-issued; the cell shows "…" until a write bumps `version` or the zone changes. The summaries
  effect in the same file (:236-248) documents this exact bug class and already removed its flag.

### CB-7 — P2 — Failed overrides on ScheduleDetailPage are completely silent
- **Where:** admin `pages/schedules/ScheduleDetailPage.tsx:76-98, 246-253, 392-399`.
- **Path:** `onOverride` re-throws non-conflict errors; callers have `try/finally` with no catch,
  fire-and-forget — network failures and 4xx/5xx produce an unhandled rejection and no UI
  feedback; a failed conflict-confirm leaves the banner up with no message. The console's own
  `OverrideForm` (`ActionsBand.tsx:529-544`) handles the same path correctly.

### CB-8 — P3 — Day-plan notification mixes cumulative stops with incremental tickets
- **Where:** `scheduling/batch-assignment.service.ts:244, 292`. On a same-day append `stops` is
  the plan's total while `tickets` counts only the new ones (3 existing stops + 1 new stop / 2
  tickets notifies `stops=4, tickets=2`). Wrong push metadata; no scheduling effect.

### CB-9 — P3 — Malformed ids → 500 instead of 404 on three controllers
- **Where:** `batches.controller.ts:124` (bare `BigInt(id)`), `intraday-updates.controller.ts:84,104`,
  `intraday-insertion.controller.ts:59,68,81`. Sibling handlers in the same files wrap and 404.

### CB-10 — P3 — Preview staleness token is minted but unconsumable (dead API surface)
- **Where:** `scheduling/scheduler-preview.service.ts:123, 135-150`. `previewToken` is HMAC-signed
  on every preview and `checkStaleness` is implemented and unit-tested, but no controller route
  consumes it — the documented #251 re-poll flow is unreachable over HTTP.

### CB-11 — P3 — MySQL zero-date becomes an 1899 `trip_creation_datetime`
- **Where:** `ingestion/autoplant/mapping.ts:170-177`. `parseTripCreation` lacks the plausibility
  floor both siblings have (`MIN_PLAUSIBLE_GPS_MS`, `MIN_PLAUSIBLE_INSTALL_MS`);
  `"0000-00-00 00:00:00"` lands as ~1899-11-30 in `device_states` for devices whose only stamp is
  the sentinel (the GREATEST guard protects the rest).

### CB-12 — P3 — Documented `work_type ⇔ status` CHECK does not exist
- **Where:** `prisma/schema.prisma:1915-1917` claims it; the only ticket CHECK in
  `migrations/20260620124718:255` is TROUBLESHOOT⇒cycle. Nothing at the DB stops a TROUBLESHOOT
  ticket at FITTED; combined with CB-5's unguarded writes the coupling is enforced nowhere below
  application code.

### CB-13 — P3 — Changes tab silently truncates at 12 rows
- **Where:** admin `pages/dispatch/console/WorkRail.tsx:413` — `slice(0,12)` with no "and N more"
  while the tab count shows the full total.

---

## 7. Architectural risks

### AR-1 — P1 — One unparseable GPS timestamp permanently truncates the fleet scan
- **Where:** `ingestion/autoplant/mapping.ts:238` (no try/catch around `normalizeSourceRow`),
  `ingestion/normalize.ts:46-48` (throws), `snapshot-ingestion.worker.ts:57, 107-109` (treated as
  a read error; scan restarts from `cursor = null` every run).
- **What happens:** the deterministic `ORDER BY device_id` keyset dies at the same row **every
  run**; all devices sorting after it are never ingested again, and via the #230 gate
  (`integration-sync.service.ts:143`) recompute, auto-recovery and ticket creation are skipped
  **fleet-wide, indefinitely**, until the source row is hand-fixed. Trigger requires bad source
  data (unverified in production); the code path is unambiguous. Contrast: `parseTripCreation` and
  `parseInstalledAt` deliberately degrade to null.

### AR-2 — P1 — One DB-rejected telemetry value → permanent PARTIAL loop → downstream frozen
- **Where:** `mapping.ts:125-135` (`coerceMainsStatus` returns any integer into a SmallInt;
  lat/lon completely unvalidated), `snapshot-ingestion.worker.ts:151-159` (same deterministic
  error through all 3 retries), `integration-sync.service.ts:143` (#230 gate).
- **What happens:** `createMany` is atomic per 90-row chunk, so one poison value fails the chunk
  forever, the run finalizes PARTIAL every 30 minutes, and everything downstream is skipped each
  tick. The design trades "fabricate on partial read" (the 3,439-cycle incident) for "freeze on
  poison row"; the freeze is loud in logs but surfaces nowhere as an alert-grade state.

### AR-3 — P2 — DEFAULT-partition wedge halts retention and compounds daily
- **Where:** `ingestion/partition-maintenance.service.ts:122-134` (`applyPlan` — creates then
  drops, no per-statement isolation).
- **What happens:** if maintenance lapses past the 3-day create-ahead, rows land in the DEFAULT
  partition; Postgres then refuses that day's `CREATE … PARTITION OF`, the throw aborts remaining
  creates **and all retention drops**, and repeats daily. Nothing ever cleans DEFAULT; after a
  retention drop, the full re-scan re-inserts each dead device's last ping into DEFAULT (the seed
  population for the wedge). Name-injection is well defended.

### AR-4 — P2 — Two parallel implementations of the six override controls
- **Where:** `ActionsBand.tsx:27-35` claims the ScheduleDetailPage controls were "moved … not
  copied"; `ScheduleDetailPage.tsx:188-491` still contains a full second implementation including
  its own `useOverridePreview`. Already diverged: console has MOVE_TICKET + error surfaces; legacy
  has silent failure (CB-7) and no Move.

### AR-5 — P2 — Invalidation fan-out re-runs the most expensive reads per click
- **Where:** `useDayContext.ts:90-119, 163-179`; backend `schedules.controller.ts:333-346,
  533-535`. Every write drops the day cache: up to six `GET /schedules?date=&detail=stops`
  (pan-India for CSM/OH) plus — with a future day focused — `GET /schedules/preview?date=`, the
  real recommender dry-run for every active zone. Ten overrides on a focused future day = ten
  national dry-runs.

### AR-6 — P2 — A failed post-write refetch tears down the whole console
- **Where:** `useConsoleData.ts:87-93`; `TodaysDispatchPage.tsx:317-327`. One transient blip after
  a **successful** write sets `view = null`: deck, selection and context replaced by an error
  card, making the write look failed.

### AR-7 — P2 — Run-now stuck disabled; RUNNING badge never updates
- **Where:** `RunNowControl.tsx:71-113`; `TodaysDispatchPage.tsx:406-414`. The in-flight pre-check
  refetches only on phase change and phase only changes via the button — a run in flight at mount
  leaves the control disabled after it finishes; with no polling, a RUNNING badge stays RUNNING
  indefinitely. Correctness is preserved server-side (409).

### AR-8 — P3 — Day-plan uniqueness is convention-held once a schedule is OVERRIDDEN (open #155)
- **Where:** migration `20260708120000:19` (partial on ACTIVE); `scheduling/schedule-status.ts:22-31`.
  Liveness is code-enforced via `liveScheduleFilter()` everywhere (#153) — one future writer that
  hand-spells `status:'ACTIVE'` recreates the two-day-plans bug. Related edge: `dispatchForSe`'s
  append lookup matches exact `dateFrom` (`batch-assignment.service.ts:214-217`) while capacity
  counts by range — a live multi-day manual schedule would yield two live plans for one (SE, zone,
  day) with no unique collision (unverified whether any writer creates one).

### AR-9 — P3 — Duplicated business vocabularies (beyond CB-5)
- `RESOLVED_TICKET_STATUSES` identical copies: canonical `ticketing/resolved-ticket-status.ts`,
  local in `schedule-closure-scheduler.service.ts:61`, local in `dashboard/dashboard.service.ts:316`
  (the canonical file documents the fold-in as deferred).
- The FLOATING live re-validation SQL hand-mirrored in `recommender/candidate-selection.service.ts:41-49`
  and `scheduling/coverage-at-assign.ts:36-45`.
- Two `NULLISH` sets for one source: `mapping.ts:120` ({'', 'NULL', 'null'}) vs
  `master-mapping.ts:34` (adds 'NA') — a literal `'NA'` device id passes the snapshot path but is
  never mastered: permanently in `unknownDevices`, telemetry unreachable, warned every chunk.

### AR-10 — P3 — Frontend re-spells backend enums; no shared types for this surface
- ~18 admin files re-spell `TicketActionStatus`, `DispatchRunStatus`, `IntradayInsertionStatus`,
  `HardFilterReason`, `CoverageType`, `ChangeKind`, `AssignBatchSkipReason`, `PoolEmptyReason`,
  `TodayRecovery.state`; `@fsm/shared` exports none of them. Most consumers are defensive; the
  non-defensive one: `RecoveryNotice` (`TodaysDispatchPage.tsx:730-739`) renders any **unknown**
  recovery state as the EXPIRED sentence — a false claim once a state is added. (#268's
  `ASSIGNED_DIRECT` was hand-synced.)

### AR-11 — P3 — Per-ticket candidate fan-out stretches the reap window
- `orderedCandidatesForPlant` is called once **per ticket** (`recommender.service.ts:593`) with no
  per-plant memoisation — ~2,000+ round trips for a 900-ticket zone, inside the window bounded by
  the 10-minute heartbeat (RC-5): the risk compounds exactly when zones are large.

### AR-12 — P3 — Acting-zone attribution inconsistent across sibling doors
- Both intraday **write** doors hardcode `actedAsRole: null` and build scope from raw claims
  (`intraday-updates.controller.ts:50-52, 88-89, 107-108`; `intraday-insertion.controller.ts:84`);
  the FE never sends the acting header to them (`api/dispatch-runs.ts`, `api/intradayInsertions.ts`,
  `api/intradayUpdates.ts` keep bearer-only local header builders — the exact past defect
  `api/schedules.ts:9-25` documents). An acting CSM's same-day add commits pan-India-scoped and is
  audited without acting attribution.

### AR-13 — P3 — Zones lost to contained in-process errors get no same-day recovery
- Only the reaper writes recovery marks (`dispatch-run.service.ts:538-540`);
  `releaseStrandedClaims` (:770-782) finalizes claims as ERROR on an unwound run but marks
  nothing — a zone that lost its day to a caught error is recorded but never re-dispatched
  automatically, unlike a zone lost to process death.

### AR-14 — P3 — Assorted structural deferrals
- Un-FK'd cross-references permit orphans: `Zone.zonalManagerUserId` (a departed ZM silently kills
  `escalateToZm` notifications — `intraday-insertion.service.ts:476-478` returns without alerting),
  `IntradayInsertion.assignedScheduleId/BatchId`, `CrossZoneEscalation.*`, `LeaveRequest.availabilityId`,
  `TicketEvent.actorId`.
- `DeviceCommissioning`'s `UNIQUE … NULLS NOT DISTINCT` is inexpressible in Prisma
  (`schema.prisma:2319-2329`); accepting `prisma migrate dev`'s offered "fix" would cause
  unbounded daily duplication — e2e-guarded, but the repo's most dangerous `migrate dev` trap.
- Master sync throws on dirty identity fields (`master-sync.service.ts:249`; `.trim()` on
  name/PK columns in `master-mapping.ts`) — one dirty row fails the whole run, unlike the
  snapshot path's per-row rejection.
- `PUT /schedules/dispatch-schedule` re-registers the cron job on the handling instance only
  (`dispatch-schedule.service.ts:116+`); other instances fire at the old hour until restart.
- Unbounded list reads: `same-day-update.service.ts:104-107`, `intraday-insertion.service.ts:462-466`
  (no `take`).
- `prisma/drift-baseline.txt`: 76 cosmetic diffs allowlisted; normalization slice (#152) not landed.
- Dead machinery: cross-run resume-cursor (`snapshot-run.service.ts:90` — zero production callers;
  `SnapshotRun.chunkStats` never written); `NoConflictSoftStatePort` constructor fallback means a
  hand-constructed `OverrideService` silently loses the ON_SITE gate (several e2e specs construct
  services by hand).
- Doc drift (P4): `scoring.ts:4-5` ("Floating only" distance), `deferral.ts:22-23` ("UTC day
  start"), `schema.prisma:1683` ("monthly" partitions — they are daily),
  `dispatch-scheduler.service.ts:56-58` ("re-checked every tick" — config is constructor-resolved).

---

## 8. Data consistency / concurrency issues

### RC-1 — P2 — Verification finalize can overwrite ESCALATED / CLOSED_AUTO_RECOVERY
- **Where:** `verification/verification.service.ts:311-329` (`finalize`), `:90-115`
  (`escalateFraud`), `:135-155` (`markAutoRecovery`).
- **Path:** the 5-min sweep reads VERIFICATION_PENDING at scan start, then writes ticket + run by
  primary key with **no status predicate**. A concurrent fraud escalation or auto-recovery mark
  committed in the window is silently overwritten with CLOSED/FAILED_VERIFICATION (and vice
  versa). Inventory consequences diverge (finalize-FAILED restores van stock; auto-recovery does
  not), so the interleaving is not cosmetic. This is exactly the `read → check-in-JS →
  update-by-id` idiom `common/transition-or-conflict.ts` was built to eliminate — used in
  sla-pause, outbox, intraday, snapshot runs, **not here**.

### RC-2 — P2 — Auto-recovery can close a ticket the SE just worked
- **Where:** `ticketing/auto-recovery.service.ts:264-276` — `closeAsAutoRecovery`'s
  `tx.ticket.update({ where: { ticketId }, data: { status: 'CLOSED_AUTO_RECOVERY', … } })` has no
  `status:'OPEN'` guard; the OPEN check happens only at scan time and a pass can run minutes (per-
  ticket ping queries, up to 200 closures). A troubleshooting submission in the window (→
  VERIFICATION_PENDING) is stomped — violating the CONTEXT rule the code's own comment (:159-161)
  claims the scan enforces. Also enables sweep-vs-manualClose double closes (duplicate events and
  audit rows).

### RC-3 — P2 — Tick claim has no reclaim: a winner dying pre-admission loses the dispatch day silently
- **Where:** `scheduling/cron-tick-claim.service.ts:51-71` (at-most-once insert, no
  TTL/heartbeat/reaper on the claim itself); `dispatch-scheduler.service.ts:93` (claim burned
  before any durable evidence exists).
- **Path:** crash between `claimTick` and `DispatchRunService.admit`'s run-row insert leaves no
  run row, no zone claims, no recovery mark — the reaper and the #286 collector key off rows that
  were never written, and the losing instance already no-oped. Minute-cadence sweeps lose one tick
  (fine); `business-dispatch` can lose the day until a human presses Run Now. Every later crash
  point in this pipeline has an explicit recovery story; this first one does not. (Found
  independently by two agents.)

### RC-4 — P2 — Concurrent runs in different zones can double-book a floating SE past capacity
- **Where:** `recommender.service.ts:504-511` (counter seeded from committed rows at zone-run
  start), `:813` (incremented only for this run's own wins); `dispatch-run.service.ts:251`
  (manual zone-scoped runs).
- **Path:** zone claims serialize per zone, not per engineer. A manual zone-scoped run or a #286
  recovery run concurrent with the 05:00 loop can each seed the same floating SE's `committed`
  from the same snapshot and each hand them up to `dailyCapacity` tickets before either commits;
  nothing downstream re-checks capacity, and `work_schedules_one_active_per_se_zone_day` is
  deliberately per-(SE, **zone**, day). An SE's day can exceed `daily_capacity` by up to another
  zone's allocation. `test/recommender-cross-zone-capacity.e2e-spec.ts` covers only the
  sequential case.

### RC-5 — P2 — A zone slower than 10 minutes self-reaps mid-run
- **Where:** heartbeat stamped only per zone and per patience iteration
  (`dispatch-run.service.ts:1104-1107, 1010-1012`), never **during** a zone's recommend+dispatch;
  reaper threshold `DISPATCH_STALE_RUN_MIN` = 10.
- **Path:** a zone exceeding 10 min of silence gets its **live** run ABORTED, its claim freed, and
  the recovery collector can start a second dispatch of a zone whose first is still writing.
  Assignment-level guards prevent double assignment (advisory lock, SKIP LOCKED, orphan-retire,
  partial uniques) and the code logs the anomaly (`finalized === 0` :953-955), but the ledger
  records ABORTED for a completed run and two runs interleave. Grows with zone size — compounded
  by AR-11.

### RC-6 — P2 — `placeHold` TOCTOU: a live deferral can land on assigned work
- **Where:** `scheduling/scheduler-preview.service.ts:169-216` — the OPEN+UNASSIGNED check
  (:178-180) is a plain read; the write (:214) is keyed on primary key only, no
  `assignmentState:'UNASSIGNED'` predicate. A manual assign / intraday direct-assign committing
  between check and write yields a live `deferred_until` on a FORMALLY_ASSIGNED ticket — the exact
  split-brain the method's own comment names. If the ticket is later REMOVEd to the pool, the
  stale date silently holds it out of every run. The repo's `stampOnceOrLose` idiom is not applied
  here.

### RC-7 — P2 — Dispatch silently wipes a hold/deferral placed mid-run — and can dispatch a just-closed ticket
- **Where:** `scheduling/batch-assignment.service.ts:168-175` (claim re-checks only "already has
  a live batch row"), `:279-284` (`data: { assignmentState:'FORMALLY_ASSIGNED', deferredUntil:
  null }, where: { ticketId }` — unconditional).
- **Path:** deferrals are honoured only at recommender selection (`notDeferredOn`). A hold placed
  (with its `SCHEDULER_HOLD_PLACED` audit row) between the SUGGESTED create and the per-SE
  dispatch tx is erased with no override record — a hold override with no confirm gate. The same
  window lets a ticket **closed** between selection and dispatch land on a day plan (recycled only
  at the 04:00 closure). Windows are seconds-to-minutes per zone and recur daily exactly when
  operators use the preview screen. Fix shape: carry `status`/`assignmentState`/deferral
  predicates on the claim join or the ticket update, like every other guarded write.

### RC-8 — P2 — A colliding manual assign costs the SE their whole engine plan for the run
- **Where:** `batch-assignment.service.ts:182-190` (re-read), `:111-116` (`seSkips`), `:359-369`
  (`clearFailedSeOrphans` retires all that SE's SUGGESTED rows); manual doors never consult
  `zone-claim.ts` (respected only by bulk-unassign and closure).
- **Path:** a manager's assign of ticket T committing after the re-read but before the create
  makes the partial unique abort the **whole per-SE transaction** (a P2002 aborts its interactive
  tx — #265); the SE is skipped and their plan for the run is discarded. Bounded and honestly
  ledgered; recovery requires a human pressing Run again.

### RC-9 — P3 — Intraday ledger row and notification sit outside the assignment tx
- **Where:** `intraday/intraday-insertion.service.ts:292-345, 417-455`. Crash between
  `assignTicket`'s commit and `intradayInsertion.create` leaves an assigned ticket with no
  ASSIGNED_DIRECT row (queue completeness, efficiency-cube inputs); in `manualAssign` the
  ESCALATION_REQUIRED row stays live-looking (mitigated at display by the #288 assignee join).

### RC-10 — P3 — Concurrent soft-state advance surfaces as a 500
- **Where:** `soft-state/soft-state.service.ts:271-309` — read → JS rank check → create; the
  loser's P2002 on `ux_ss_active` escapes unhandled. Mobile double-tap is the realistic trigger.

### RC-11 — P3 — Narrow windows (grouped)
- Outbox `drainRow` stamps `sentAt` before delivering (`day-plan-notification-outbox.ts:106-131`)
  — conscious at-most-once; a crash in the gap loses one notification.
- Lock-order inversion: `assignLane` locks ticket→inserts batch row; `assignTicket` inserts batch
  row→updates ticket — concurrent same-ticket execution can deadlock (40P01 → unhandled 500).
- `nextStopSequence`/`nextSortOrder` are `max+1` with no unique on `(schedule_id, stop_sequence)`
  — concurrent adds can mint duplicate stop numbers (cosmetic; self-heals on reorder).
- A snapshot run stalled >30 min on one chunk is reaped while alive; the zombie's return value
  still drives recompute/auto-recovery/ticket-creation concurrently with the new run's (data-safe
  via ON CONFLICT/GREATEST/I1, but reaches RC-2 from two sides).
- Past-dated holds/defers accepted silently: `placeHold` with `heldUntil <= today` returns OK
  while holding nothing; `DEFER_TICKET` with a past/garbage date is a bare remove or a 500.
- FE edges: Back-button restores `?sel=` and re-opens a cancelled drag dialog
  (`TodaysDispatchPage.tsx:126-188, 580`); Escape inside a mandatory-reason field closes the
  modal and discards the draft (`:255-270` + `Modal.tsx:39-46`).
- Ticket-creation repeat-detection read sits outside the tx (`ticket-creation.service.ts:104`) —
  milliseconds window, minimal exposure; broad P2002 catch (:151-154) treats any unique violation
  as "I1 holds" (harmless given the writes involved).

---

## 9. Missing / weak tests

**Posture:** 435 backend spec files (373 e2e vs real Postgres in an isolated `*_test` DB, injected
`now` — no fake timers, env allowlist, serial file execution, a purpose-built barrier-based
concurrency harness) + 122 admin RTL tests; a custom runner defeats the #184 Windows worker crash;
first all-green full suite recorded 2026-08-20. The gaps that matter:

1. **The fixture that masks CB-1:** `me-work-history.e2e-spec.ts` fabricates closures with a bare
   `ticketEvent.create` instead of driving `retireAssignmentOnClosure` — any assigned/completed
   assertion must close tickets through the real closure writer.
2. **No race test** for verification finalize vs fraud/auto-recovery (RC-1/RC-2) — the harness
   exists and would find it.
3. **No crash test** between `claimTick` and the run-row insert (RC-3) — every later crash point
   is covered (`dispatch-run-reaper`, `dispatch-crashed-zone-recovery`); the first is not.
4. **Capacity race:** cross-zone e2e covers only sequential runs (RC-4).
5. **Hold semantics:** `scheduler-preview.e2e-spec` is happy-path only — nothing for RC-6/RC-7 or
   past-dated holds; no reason-required pin on `/batches/:id/override` (CB-3); no preview/commit
   ON_SITE parity pin (CB-4); no HTTP consumer of `checkStaleness` (CB-10).
6. **No cross-layer enum pins:** nothing asserts the admin's re-spelled status maps cover backend
   members (AR-10), and no drift pin on the four terminal-status copies (CB-5/AR-9) despite the
   canonical file flagging them.
7. **Frontend:** no test for mid-flight day navigation (CB-6), the escalation-strip → Assign →
   strip-clears round trip (CB-2 — existing tests stop at "selecting opens the Inspector"),
   ScheduleDetailPage failure paths (CB-7), post-write refetch failure (AR-6), cross-midnight
   behavior, or `useConsoleData`'s stale-response counter.
8. **Ingestion:** no test for the poison-row freeze modes (AR-1/AR-2), the zero-date trip stamp
   (CB-11), the DEFAULT-partition wedge (AR-3), dirty master identity fields, or the 'NA'
   asymmetry. The resume-cursor spec tests a reader production doesn't use.
9. **Scheduler core:** untested — slow-zone self-reap while alive (RC-5), the mid-run deferral
   wipe (RC-7), multi-day manual schedule vs the exact-`dateFrom` append lookup (AR-8 edge), the
   stops/tickets notification payload on append (CB-8), manual-assign-vs-dispatch collision
   consequence (RC-8).

---

## 10. Unknowns (UNVERIFIED)

- **Dashboard activity trend buckets by UTC day** (`dashboard.service.ts:1135-1143`) while the
  platform's operating day is IST — intent unconfirmed; if the chart means operating days, every
  boundary sits at 05:30 IST.
- **On FAILED_VERIFICATION the failure cycle stays SUBMITTED/open** (with
  `hasOpenFailureCycle = true`) until the repeat-escalation sweep moves it — appears intentional,
  but no backstop exists if that sweep fails; ticket-terminal/cycle-open persists indefinitely.
- **Whether any writer creates multi-day `work_schedules`** — activates AR-8's second-live-plan
  edge.
- **Whether production AutoPlant data contains the poison rows** that trigger AR-1/AR-2 — the code
  paths are unambiguous; trigger frequency is not.
- **MoveForm reports the landed day from client input** (`ActionsBand.tsx:790`) rather than the
  server's `movedToDate` — agrees for valid `YYYY-MM-DD`; a divergence would misfocus the board.
- **Escalation rows carry no `plantId`** in the contract (`TodayEscalation`, both sides), so the
  Inspector's candidate band can be empty on exactly the row whose only decision is choosing a
  candidate — design gap vs data gap unconfirmed.
- **Whether the intraday controllers read the acting header at all** (AR-12's FE half assumes
  not; verified only that the FE never sends it).

---

## 11. Prioritized remediation plan

### Wave 1 — user-visible wrong answers & activation blockers (P1)
1. **CB-1:** count completions from closure events regardless of `removedAt` (exclude only
   human-withdrawal removal reasons); fix the fixture to drive the real closure writer.
2. **CB-2:** close ESCALATION_REQUIRED inside `assignTicket`'s tx (mirror `moveTickets:1149`) or
   filter `escalationsOpen` on ticket assignment state; add the round-trip test.
3. **AR-1 / AR-2** — before the ingestion cron is enabled in production: per-row catch →
   reject-and-count for unparseable GPS (match `parseTripCreation`'s degrade-to-null posture at
   row granularity); range-validate coerced numerics before insert; surface persistent-PARTIAL as
   an alert-grade state, not a log line.

### Wave 2 — correctness under concurrency (P2)
4. **RC-1 / RC-2:** apply `transitionOrConflict` / guarded `updateMany` to verification finalize,
   fraud escalation, and auto-recovery ticket writes.
5. **RC-7 + RC-6:** carry status/deferral predicates on dispatch's ticket update (or the claim
   join) and on the hold write; decide the hold-vs-in-flight-run policy explicitly (refuse, or
   record an override).
6. **RC-3:** write the run row before (or atomically with) the tick claim for `business-dispatch`,
   or give tick claims a heartbeat + reaper.
7. **RC-4 / RC-5:** heartbeat per SE inside the zone loop; re-check (or re-seed) capacity at
   dispatch claim for floating SEs, or serialize per engineer.
8. **CB-5 + CB-12:** fold the four terminal-status sets into `resolved-ticket-status.ts`, add a
   drift-pinning test, add status guards to departure/deactivation closes; add the missing CHECK
   or an application-level invariant test.
9. **CB-3 / CB-4:** DTO-validate the override body (mirror the intraday controller's 400s); inject
   `SOFT_STATE_CONFLICT` into `OverrideProjectionService` and populate `onSite`.
10. **CB-6 / CB-7 + AR-6:** drop the `live` flag from the counts/projection effect (as the
    summaries effect already did); add catch+message to ScheduleDetailPage; keep last-good view
    with a stale banner on failed invalidate.
11. **AR-3:** per-statement error isolation in `applyPlan`; a DEFAULT-partition drain path.

### Wave 3 — structural (P2/P3)
12. **AR-4:** delete ScheduleDetailPage's control copy; route it through ActionsBand (the file's
    own stated design).
13. **AR-5 / AR-7:** scope invalidation to affected days; refetch run status on an interval or on
    window focus.
14. **AR-8:** land #155 (duplicate probe, then extend the partial unique over live statuses — or
    split lifecycle from provenance per #154).
15. **AR-10:** export the scheduling enums from `@fsm/shared`; add the cross-layer parity pin; fix
    `RecoveryNotice`'s unknown-state fallback.
16. **AR-12:** sweep acting-zone through both intraday write doors and the three bearer-only FE
    header builders.

### Wave 4 — hygiene (P3)
17. CB-8/9/10/11/13; RC-9 (ledger row into the tx), RC-10 (catch the P2002 → IDEMPOTENT), RC-11
    guards (past-date validation, lock ordering, stop-sequence unique); AR-9 vocabulary folds
    (one NULLISH set, one FLOATING SQL); AR-11 per-plant candidate memoisation; AR-13 recovery
    symmetry; unbounded list `take`s; Escape/Back-button edges; dead resume-cursor cleanup.

---

## Appendix — what is demonstrably solid (verified, for calibration)

- **Double assignment is impossible at the DB** (`batch_assignment_tickets_one_active_per_ticket`),
  and all three assign paths recover from the race honestly (409 / `LOST_RACE` skip /
  `alreadyAssigned` fold).
- **Terminal stamps cannot be overwritten** — every remover/deferrer/mover/recycler keys on
  `removedAt: null` (`stampOnceOrLose`), and audit rows roll back with the mutation.
- **Run/claim finalizes are first-writer-wins** status-guarded `updateMany` everywhere; a reaped
  run cannot resurrect.
- **Ingestion is idempotent and non-fabricating**: `(device_id, gps_datetime)` unique +
  skipDuplicates, GREATEST/COALESCE watermarks, the #230 gate, I1 backstop, ledger re-reads
  instead of derived flags.
- **Notifications are outbox-based and post-commit** with a bounded re-drain backstop (#264).
- **Previews write nothing** — `OverrideProjectionService` and `DistributeProjectionService`
  contain no mutation, asserted by counting rows across five tables.
- **Holds are excluded from capacity and every pool read**; every manual door requires
  confirm+reason to break one (#249, uniform 409 shape).
- **One shared readiness/capacity definition** across engine, candidate column, Assign Console and
  Distribute (`buildCandidateReadiness` / `applyHardFilters` / `committedDayLoad`) — the surfaces
  cannot drift from the engine.
- **IST day math is consistent and pinned** (`common/ist-day.ts`; session TZ pinned UTC;
  business-day crons pinned `Asia/Kolkata`).
- **Bulk-unassign is the best-behaved mutation in the codebase**: zone-claim check, advisory lock,
  in-lock re-classification, signed Pan-India token with server-side staleness re-check, per-zone
  skip audit.
