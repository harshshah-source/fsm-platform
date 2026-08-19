# 242 — Unresolved assignments recycle at schedule closure (`PLAN_EXPIRED`)

Status: ready-for-agent
Type: AFK · Backend

Filed 2026-08-19. **The load-bearing lifecycle change of the approved design** (Decisions 6/8): a
dispatched-but-unworked ticket must return to the pool when its day plan closes. Without it, no
ticket is ever assigned a third time (measured max ever: 2, all via 20 human bulk-unassign
operations) and Special (#244) can never fire.

## What to build

### Current behaviour (verified)

`ScheduleClosureScheduler.closeZone` (`schedule-closure-scheduler.service.ts:129-172`) flips
past-dated live schedules to `PARTIAL`/`COMPLETED` — **and nothing else**. The batch row keeps
`removed_at NULL`, the ticket keeps `FORMALLY_ASSIGNED`, the recommender selects `UNASSIGNED` only,
and `MeTicketsQueryService` reads live schedules only — so the ticket is invisible to the scheduler
*and* to the SE ("double limbo"). 4,983 OPEN tickets sit stranded this way in the dev DB (re-measured 2026-08-19). **They are NOT
cleaned before this slice** — Option B reversed that ordering: `closeZone` only ever selects
still-live schedules, so this sweep can never reach them, and the backlog grows ~300 a night
until this slice ships. Build and enable this first; #243 then cleans a frozen set once.

### Required change

Inside `closeZone`'s existing per-zone transaction and advisory lock, after the PARTIAL/COMPLETED
computation, two **set-based** statements over the closing schedules' rows:

```text
1. batchAssignmentTicket.updateMany
     WHERE batch.schedule IN (closing) AND removed_at IS NULL
       AND ticket.status NOT IN RESOLVED_TICKET_STATUSES      -- the file's existing constant
     SET removed_at = now, removed_by = NULL, removal_reason = 'PLAN_EXPIRED'
2. ticket.updateMany (the tickets from 1)
     SET assignment_state = 'UNASSIGNED'                      -- deferredUntil untouched
```

Plus a backstop stamp for resolved-ticket stragglers on the same closing schedules
(`removal_reason = 'RESOLVED_AT_CLOSURE'` — #241's departure-stamp should make this rare).

Report `recycled` per zone on the closure outcome/log. On the dispatch-run ledger, count tickets the
recommender silently drops for missing `slaBucket` (`recommender.service.ts:197`) — recycling grows
that population's exposure and it must not vanish uncounted.

### Why every protected class is safe (verified)

| Class | Protection |
|---|---|
| Completed / resolved tickets | Excluded by the `RESOLVED_TICKET_STATUSES` filter (backstop-stamped, never unassigned) |
| Human withdrawals / defers / bulk unassign | Rows already `removed_at IS NOT NULL` — outside the filter |
| Auto-recovered | Doubly excluded: resolved status + row already stamped |
| Valid active assignment elsewhere | Impossible — `batch_assignment_tickets_one_active_per_ticket` (partial unique) means the stamped row was the ticket's only live assignment |
| Overridden / reassigned | Closure already processes `OVERRIDDEN` schedules; moved tickets live on the destination batch and recycle when *that* plan closes; `SWAP_SE` carries rows to the new SE untouched |
| Return-date deferrals | Their rows were removed at filing (#246); the sweep never writes `deferredUntil` |
| Idempotency | Second pass matches nothing (`removed_at IS NULL`); partial unique is the cross-connection backstop |

### Existing code to reuse

`closeZone`'s lock/transaction/unresolved-set computation; `RESOLVED_TICKET_STATUSES`;
`liveScheduleFilter`; #241's reason constants. Honour the file's own lock-window warning: set-based
statements only, no per-ticket fan-out, no notification I/O inside the lock.

### Tests

- e2e day-cycle: dispatch → unworked → closure → row stamped `PLAN_EXPIRED` + ticket `UNASSIGNED` →
  next `runForZone` selects it again (attempt row #2 created).
- One test per protected class in the table above.
- Idempotency: `closeTick` twice → second is a no-op.
- Capacity: `committedDayLoad` unchanged by the stamps (closed schedules already excluded).
- Ledger: recycled count on the outcome; bucket-less-dropped count on the run row.

### Risks / rollback

Release volume: bounded after #243 (~1,357 immediately dispatchable at the 2026-08-18 snapshot);
counted, never silent. Lock window: two `updateMany` statements. Rollback: disable via the existing
`BUSINESS_SWEEPS_ENABLED` posture or revert; stamped rows are identifiable by reason.

## Acceptance criteria

- [ ] AC1 — An unresolved ticket on a closing schedule ends the day `UNASSIGNED` with its row
      stamped `PLAN_EXPIRED` (`removed_by NULL`), and the next dispatch run can assign it again.
- [ ] AC2 — All seven protected classes above are pinned by tests and untouched.
- [ ] AC3 — Recycling is idempotent and runs entirely inside the existing per-zone lock as set-based
      statements.
- [ ] AC4 — `deferredUntil` is never written by the sweep; a deferred-then-recycled history keeps
      its dates intact.
- [ ] AC5 — Closure outcome reports the recycled count; the dispatch-run ledger counts
      bucket-less-dropped tickets.
- [ ] AC6 — The SE-facing effect is verified: a recycled ticket reappears via the shared-pool branch
      of `/me/tickets` (coverage permitting) instead of being invisible to both sides.

## UI surfaces

n/a (ledger counts surface through the existing dispatch transparency page without layout change)

## Reference

n/a

## Blocked by

#240 (closure must precede dispatch in IST), #241 (reason column). **Enablement gate:** #243
executed first (approved Decision 9 — clean state before the new lifecycle).
