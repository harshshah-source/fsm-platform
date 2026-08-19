# #242 — Unresolved assignments recycle at schedule closure (`PLAN_EXPIRED`)

**Done 2026-08-19.** Backend only. Built on #240 (closure fires in IST, ahead of dispatch) and #241
(the removal-reason column and its closed vocabulary). Unblocks **#244** (Special ticket — reached
attempts), and Option B makes it the prerequisite for **#243** rather than the other way round.

## What this closes

`ScheduleClosureScheduler.closeZone` flipped a past-dated schedule to `PARTIAL` / `COMPLETED` and
touched **nothing else**. So a dispatched-but-unworked ticket kept `removed_at NULL` and
`assignment_state = FORMALLY_ASSIGNED` for ever, and that pair of facts put it in a **double limbo**:

- invisible to the **scheduler** — the recommender selects `OPEN` + `UNASSIGNED` only, so the ticket
  was never a candidate again;
- invisible to the **SE** — every day-plan read requires a *live* schedule, and that schedule was now
  terminal.

The ticket belonged to nobody, permanently. 4,983 OPEN tickets were sitting that way in the dev mirror,
and the maximum number of assignment attempts any ticket on this platform had ever reached was **2** —
every one of those via a human bulk-unassign, never by the engine. #244 counts *reached* attempts; with
no third attempt possible, Special could never fire at all.

Two writes close it, inside `closeZone`'s existing transaction and advisory lock, after the
PARTIAL/COMPLETED computation:

1. **Recycle** — every still-live row on a closing schedule whose ticket is unresolved is stamped
   `removed_at = now`, `removed_by = NULL`, `removal_reason = PLAN_EXPIRED`, and the ticket goes back
   to `UNASSIGNED`.
2. **Backstop** — a row still live on an *already-resolved* ticket is stamped `RESOLVED_AT_CLOSURE`
   and the ticket is **left alone**.

## The three design calls worth recording

**Order matters, and the existing #147 spec proves it.** The recycle runs *after* the PARTIAL /
COMPLETED computation, because that computation asks "was any still-assigned ticket left unresolved?".
Recycling first removes exactly those rows, so every closing schedule would read `COMPLETED` — a day
the SE never finished, recorded as finished. This is not a theoretical hazard: moving the call above
the computation turns `schedule-closure-scheduler.e2e-spec.ts`'s "records COMPLETED when the day's work
is done and PARTIAL when it is not" red, verified. The ordering is therefore already pinned by a spec
written eight issues ago, which is the best kind of guard.

**Resolved work is stamped but never unassigned.** The stamp exists because the leak is the #241 class:
every day-plan read filters `removed_at IS NULL` and *not* ticket status, so a live row on a closed
ticket keeps rendering on an SE's plan as work to do. The *non*-unassignment is the more important
half — returning finished tickets to the pool is the one thing a recycler must not do. #241 gave each
resolving path its own departure stamp, so this backstop should rarely fire; it exists for the paths
nobody has thought of yet, which is the only kind of backstop worth having.

**`assignment_state` is written, `deferred_until` never is.** A ticket can be both recycled and waiting
on a vehicle (#246): `UNASSIGNED` says *something* may re-plan it, `deferred_until` says *not yet*. The
sweep writes only the first, so a plan expiring cannot cancel a wait for a vehicle that is provably
absent. Pinned from the recycling side (a recycled ticket keeps a +16-day return date) and from the
protection side (a `VEHICLE_UNAVAILABLE` row keeps its reason *and* its date).

Also worth stating plainly, because the alternative reading is tempting: `RESOLVED_TICKET_STATUSES`
excludes `SUBMITTED`, `VERIFICATION_PENDING` and `ESCALATED`, so those **are** recycled. That is
correct and deliberate. The constant is the file's own definition of "the day's work on that ticket is
over", and closure already treats those statuses as unfinished work (they are what make a schedule
`PARTIAL`). None of them can be re-dispatched — the recommender requires `OPEN` — so what recycling
actually buys is *consistency*: `FORMALLY_ASSIGNED` with no live row is precisely the stranded C3 class
#243 exists to clean, and leaving the sweep's own output in that shape would manufacture more of it.

## Why this cannot heal history (and why that flipped the build order)

`closeZone` selects `dateTo < today AND liveScheduleFilter()`. Once a schedule flips to `PARTIAL` it is
**never selected again**, and the recycler lives inside that method — so it structurally cannot reach
the 8,293-row historical backlog. It stops the bleeding from today forward; it cannot heal what has
already bled. Meanwhile that backlog was accruing ~300 rows every night the closure cron ran without
this slice.

The operator's **Option B** follows from those two facts: build and enable #242 first, then let #243
clean **once**, on a set that has stopped growing. Cleaning first would have guaranteed cleaning twice.
#242's issue file carried the opposite ordering as an "enablement gate"; that line is now corrected in
place. #243 remains `Type: HITL` / `ready-for-human` — Option B decided the *order*, not the execution.

**No configuration change was needed to enable this.** `BUSINESS_SWEEPS_ENABLED` is already `"true"` in
the dev environment, so the recycler is live from the moment the code ships and the nightly growth stops
with this commit rather than with a follow-up action.

## The lock, and why "set-based" is asserted as data rather than as a comment

The class docstring is explicit that widening the lock window trades a stale plan for a **missing**
one: a dispatch that finds `dispatch_zone_<id>` held records `LOCK_CONTENDED` and skips the zone for the
whole run, leaving its SEs without a day plan for the day. So the recycle is one read plus three
`updateMany`s — no per-ticket fan-out, no notification I/O.

That property is unreadable from a passing test, so it is asserted as a fact about the data: **every row
a zone stamps carries the identical `removed_at`**. A per-ticket loop taking its own `new Date()` cannot
produce that, and replacing the `updateMany` with such a loop turns exactly that test red (verified).
The ticket ids are read first because `updateMany` returns a count rather than rows and the second write
needs the very tickets the first stamped; the read is the same shape the PARTIAL computation above
already performs.

Idempotency is structural — `removed_at IS NULL` is the filter, so a second pass matches nothing — and
under concurrency the partial unique `batch_assignment_tickets_one_active_per_ticket` is the backstop:
this method can only ever *remove* liveness, never create a second live row.

## AC5's second clause — the population nobody was counting

`runForZone` ranks with the canonical sort, which needs an SLA bucket, so it drops every candidate whose
`device_states.sla_bucket` is NULL (or whose device has no state row) **before any decision is taken**:
no recommendation, no UNASSIGNABLE row, no decision trace, no ledger figure. On a run report those
tickets simply did not exist — neither dispatched, nor unassignable, nor withheld.

Measured on the dev mirror while building this: **5,127 of 6,464** OPEN + UNASSIGNED Troubleshoot
tickets carry no computed bucket. The invisible class is the *majority* of the pool, not an edge case —
and it reconciles with #242's own risk estimate (6,464 − 5,127 = 1,337, against the ~1,357 "immediately
dispatchable" figure the issue quoted from the 08-18 snapshot), which means that figure had already
been netting this population out without saying so.

`bucketless_dropped` now lands on `dispatch_runs` and `dispatch_run_zones`, kept apart from both
neighbours for #238's reason: `unassignable` means the engine **looked and found nobody** (an Ops
coverage/capacity failure), `withheld_below_threshold` means it **deliberately did not look yet**
(policy working), and this means it **could not look** (a data fault — an un-recomputed device state).
Three different queues; folding them together sends the wrong team.

The column is **nullable**, unlike #238's. That column defaults to 0 honestly, because a run predating
its gate genuinely withheld nothing. This drop has been happening all along and simply went unmeasured,
so 0 on a historical row would assert a measurement nobody took. NULL reads as "not recorded", and a
zone whose recommender threw records NULL rather than a fabricated 0.

## Disposition — accepted with follow-up #252

#242's `## UI surfaces` line claimed the ledger counts "surface through the existing dispatch
transparency page without layout change". **That was false and is corrected in place.**
`DispatchRunZoneCard` (`dispatch-transparency-query.service.ts:26`) projects neither
`bucketless_dropped` nor #238's `withheld_below_threshold`, so neither reaches the admin page at all.

AC5 is a **ledger** requirement and is met as written. The rendering gap is real, pre-dates this slice
(it is #238's gap too), and is owned by follow-up **#252 — Surface the two "engine did not decide"
counters on the dispatch transparency zone card**, filed in `INDEX.md`. Extending the zone card is a UI
change with its own reference question and is deliberately not smuggled into a backend slice.

## Tests

New: `test/schedule-closure-recycling.e2e-spec.ts` (14) and `test/dispatch-run-bucketless.e2e-spec.ts`
(3). Both were written and run **red first**; the 9-of-14 and 3-of-3 initial failures are the
behavioural ACs, and the 5 that passed from the start are the protected-class assertions — vacuously
true before the sweep existed, and load-bearing the moment it did.

- **AC1** runs the *real* recommender and dispatcher across two IST days, because the claim is that a
  **second attempt** becomes possible and only the real engine can demonstrate that it now selects a
  ticket it previously could not see. Asserts attempt #2 exists: two rows, one live.
- **AC2** — one test per protected class: resolved (stamped `RESOLVED_AT_CLOSURE`, still
  `FORMALLY_ASSIGNED`), ZM withdrawal (actor *and* reason survive), auto-recovery, reassigned (source
  stamp preserved, destination row on today's still-open plan untouched), vehicle-unavailable, plus the
  partial-unique argument for "a valid live assignment elsewhere".
- **AC3** — idempotency, the one-instant set-based proof, and the lock: a zone whose dispatch holds
  `dispatch_zone_<id>` comes out of the tick with its row live, its ticket `FORMALLY_ASSIGNED` and its
  schedule `ACTIVE`, then is caught by the next tick. Skipping is a deferral, not an abandonment.
- **AC6** asserts the *transition*, not just the end state: before the tick the ticket reads as an
  assigned plan item on a day that is over (`assigned: true`, `PLAN`) because `MeTicketsQueryService`
  has no date predicate of its own; after it, it is pickable shared-pool work (`assigned: false`,
  `VISIT_NOW`).
- Capacity is asserted behaviourally at `dailyCapacity: 1`, where an off-by-one would show: an SE whose
  closed yesterday still counted could never be given today's ticket.
- #241's removed-row invariant is re-asserted **table-wide** after the new writer has run — a
  fixture-scoped version would pass for any future writer that forgets its reason.

**Sensitivity verified, not just green.** Four load-bearing behaviours were broken one at a time and
exactly the right test went red each time: recycling before the PARTIAL computation → the #147 spec's
COMPLETED/PARTIAL test; dropping the resolved carve-out → the resolved protected-class test; adding
`deferredUntil: null` to the ticket update → AC4; replacing the `updateMany` with a per-ticket loop →
the one-instant test. All restored.

## Verification

`tsc --noEmit` clean. Targeted regression across the 15 specs that touch closure, dispatch runs,
recommender projections, preview, deferral lifecycle, removal reasons and `/me/tickets`: **87/87**.
Full backend suite recorded in `INDEX.md`'s session log.

**Dev DB migrated** (`prisma migrate deploy` → `fsm`@5433, migration
`20260819140000_bucketless_dropped_ledger`; both columns verified nullable in
`information_schema`). Read-only measurement afterwards: **0** live rows on past-dated live schedules
(nothing pending), **198** live rows on today's ACTIVE schedules — all 198 unresolved, 0 resolved — so
the first night this runs it releases 198 tickets and the ~300/night growth of the stranded backlog
stops. That 198 is exactly the "explicitly untouched" figure from the 2026-08-19 #243 re-measure,
which is the expected identity: today's live work is tomorrow's recycle set.

**This is not #243.** Nothing historical was touched: the sweep cannot reach a `PARTIAL` schedule, and
no cleanup script was written, dumped or executed. #243 stays HITL with counts to be re-measured at
execution time.
