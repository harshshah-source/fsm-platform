# 265 — Lost-race hygiene: clean conflict answers and first-writer-wins attribution

Status: ready-for-agent
Type: AFK · Backend
Decision: #258 Parts 5–6 (G4, G7)

## Objective

Every legitimate concurrency race on the manual paths ends with a correct winner, a clean explained
4xx for the loser, and untouched attribution — never a 500, never a silently overwritten
`removed_by`/`removal_reason`.

## Current behaviour (all verified 2026-08-20)

- `assignTicket`'s `ALREADY_ASSIGNED` check is outside its tx (`override.service.ts:344`); two
  admins assigning the same ticket both pass it, the loser's `batchAssignmentTicket.create` hits
  `batch_assignment_tickets_one_active_per_ticket` and the P2002 propagates as an unhandled 500.
- `ensureSchedule` find-then-create (`override.service.ts:585-596`): two concurrent assigns to the
  same SE race the schedule unique → loser 500s.
- `removeTicket` reads the live row outside the tx and updates **by primary key with no
  `removedAt: null` re-assertion** (`override.service.ts:196-206`): a concurrent remover — or the
  04:00 closure recycle, which correctly guards its own writes
  (`schedule-closure-scheduler.service.ts:263,270`) — gets its `removedAt`/`removedBy`/
  `removalReason` overwritten by the later committer. Same shape in `deferTicket` (`:245`) and the
  removal legs of `moveTickets`.
- Intraday `accept` omits the #249 deferral opt-in (`intraday-insertion.service.ts:190`, also
  `manualAssign:310`), so a ticket deferred between offer and accept burns the retry chain against
  an invisible hold. (#268 retires the acceptance flow for CRITICAL; the `manualAssign` leg and the
  shared `assignTicket` behaviour keep this relevant.)

## Required change

1. `assignTicket`: catch P2002 on the batch-ticket create → re-read → return `ALREADY_ASSIGNED`
   (existing outcome vocabulary); controllers already map it to 409.
2. `ensureSchedule`: catch P2002 on the schedule create → re-find with `liveScheduleFilter()` →
   proceed with the winner's schedule (the intent — "get me the SE's live schedule" — is satisfied).
3. All terminal stamps on `batch_assignment_tickets` (`removeTicket`, `deferTicket`, `moveTickets`
   removal leg) become conditional `updateMany({where: {id, removedAt: null}})`; count 0 → the row
   was already terminal → return a clean `CONFLICT`/`NOT_FOUND` outcome and write NO audit row
   claiming an action that did not happen.
4. `manualAssign` and any surviving intraday assign leg pass an explicit deferral decision to
   `assignTicket` (surface `CONFLICT_DEFERRED` to the ZM rather than mis-mapping it).
5. Sweep the other override actions (`swapSe`, `reorder`, `flagOverridden`) for the same two
   shapes (unguarded terminal writes; unhandled P2002) and fix inline — the sweep result is part of
   the report, the #218 lifecycle-drift style.

## Existing code to reuse

`transitionOrConflict` (#101's helper — items 3/4 are exactly its pattern); `OverrideOutcome`
union; `REMOVAL_REASONS` vocabulary; closure's guarded-write precedent.

## Data model / API

None / no contract change — only 500s become honest 409/conflict outcomes.

## UI surfaces

Admin: existing conflict banners already render `CONFLICT_*` outcomes; verify the two new paths
reuse them. Mobile: n/a.

## Acceptance criteria

- [ ] Two concurrent `assignTicket` calls for one ticket: one OK, one `ALREADY_ASSIGNED` (409), no
      500, exactly one live batch row (asserted table-wide).
- [ ] Two concurrent assigns to one schedule-less SE: both OK, ONE schedule row, stops sequenced
      without collision.
- [ ] Concurrent remove/remove and remove/closure: first writer's attribution survives verbatim;
      loser gets a clean outcome and no audit row.
- [ ] A deferred-mid-flight manual assign surfaces `CONFLICT_DEFERRED` to the caller.
- [ ] Full override/batch spec suite (5 batch-override + 4 bulk-unassign specs) stays green.

## Tests

e2e race specs using two live connections (the #255-established fixture discipline); unit for the
P2002 re-read branches.

## Dependencies / Blocked by

None. Independent; safe to land before or after #262 (both touch `batch-assignment` messages —
coordinate the `SCHEDULE_CONFLICT` labeling with #262 item 3 if they land together).

## Risks

Low — behaviour-preserving on the happy path; the guarded updates change loser outcomes only.

## Rollback

Code-only.
