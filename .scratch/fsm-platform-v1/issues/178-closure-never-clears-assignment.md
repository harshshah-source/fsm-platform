# 178 — Ticket closure never clears assignment state (351 closed tickets burn phantom capacity)

Status: ready-for-agent
Type: AFK · Backend

Filed 2026-07-29 (found during the #179 bulk-unassign design investigation; independent companion —
#179's predicate excludes these rows, this issue fixes why they exist).

## The defect

No closure path clears a ticket's assignment or removes its live batch row. The complete list of
`assignmentState: 'UNASSIGNED'` writers in `src/` (grep 2026-07-29): the component-request
resubmit RETURN_TO_POOL (`component-request.service.ts:243`), the two ZM override paths
(`override.service.ts:152`, `:203`), and read-side `where` clauses. Verification close, recovery
close (`recovery.service.ts:157`), install close (`install-lifecycle.service.ts:238`),
device-departure cancel (`device-departure.service.ts:286`) and plant-deactivation cancel
(`plant-deactivation.service.ts:176`) all set a terminal status and touch neither
`assignment_state` nor `batch_assignment_tickets.removed_at`.

**Measured 2026-07-29 (dev DB, read-only):** 351 tickets are `CLOSED` + `FORMALLY_ASSIGNED` with
live batch rows. The arithmetic closes exactly: 7,150 live batch rows = 6,799 OPEN assigned +
351 CLOSED.

## Why it matters (not cosmetic)

1. **Phantom capacity, forever.** `committedDayLoad` counts live batch rows on live schedules
   with **no ticket-status filter** (`recommender.service.ts:600-607`) — a closed ticket burns a
   capacity slot until its schedule dies, and per #147 nothing ever closes a schedule. The SE
   looks loaded with work that is finished; the recommender under-fills them accordingly.
2. **The SE day plan serves closed tickets.** The day-plan read filters `removedAt` only
   (`day-plan-query.service.ts:54-57`) — finished work renders as live stops-content.
3. **Every consumer of "live assignment" inherits the lie** — admin assignment context, ZM
   schedule views, #179's preview arithmetic (its predicate excludes them, but the class must be
   *reported*, and today it is invisible).

## What to build

1. **Mechanism**: on terminal closure (all paths listed above), stamp the ticket's live batch row
   `removed_at = now` with a system-attributed `removed_by`, in the same transaction as the status
   flip. Consider a shared helper so the six call sites cannot drift (the #153 lesson: one
   predicate, one writer). Whether to also flip `assignment_state = 'UNASSIGNED'` on closure is a
   semantics choice — recommend yes for invariant cleanliness ("FORMALLY_ASSIGNED ⇒ live work"),
   but the batch-row stamp is the load-bearing half (both `committedDayLoad` and the day plan key
   on `removed_at`).
2. **Backfill the 351** (dry-run-gated, #128 posture): stamp their live batch rows and clear
   assignment state; report before/after counts. Probe first — do not assume the count still
   matches at execution time.
3. **Regression**: e2e per closure family (verification close, recovery warehouse-receipt close,
   departure cancel, deactivation cancel) asserting the batch row is stamped and committed load
   drops.

## Acceptance criteria

- [ ] Closing a ticket by any path removes it from `committedDayLoad` and from the SE day plan in
      the same transaction (e2e per closure family)
- [ ] `FORMALLY_ASSIGNED ⇒ status is live` holds after the backfill (query-asserted); the 351
      measured on 2026-07-29 are cleaned up with a dry-run report first
- [ ] No history destroyed: batch rows are stamped, never deleted; `removed_by` distinguishes the
      system actor from ZM removals
- [ ] #146 interplay: the closure stamp must NOT set `deferred_to_date` and must not disturb the
      removal-scoped scorecard reads (`recommender.service.ts:548-555` family)

## UI surfaces

n/a (data correctness; existing surfaces get truthful numbers).

## Reference

n/a.

## Blocked by

- None. Independent of #179 (whose predicate already excludes CLOSED); lands whenever. Touches the
  same tables as #147's schedule-closure work — coordinate, don't merge: this is ticket-level,
  #147 is schedule-level.
