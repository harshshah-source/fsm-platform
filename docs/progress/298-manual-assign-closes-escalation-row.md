# #298 — Manual assignment closes the escalation row it resolves (TDD completion report)

**Date:** 2026-09-02 · **Branch:** `feat/autoplant-integration` · **Type:** AFK · Backend + admin test
**Issue:** [`.scratch/fsm-platform-v1/issues/298-manual-assign-closes-escalation-row.md`](../../.scratch/fsm-platform-v1/issues/298-manual-assign-closes-escalation-row.md)
**Finding:** CB-2, `audit/2026-09-01-scheduler-engine-forensics.md` §6 · Wave 1 / P1 (independent).

> Frozen once written, per the progress convention. Corrections go to INDEX / SYSTEM-STATE.

## What was wrong

The Scheduler Console's red interception strip says "N critical tickets need manual assignment" and
offers "Assign this work →". An operator who did exactly that saw the row return on the very next
refetch — still counted in `criticalNeedsYou`, now reading "Reassign this work →". The escalation
never cleared, through any number of correct assignments.

A cross-layer defect in which every component was individually right. `ActionsBand` → `apiAssignTicket`
→ `POST /schedules/assign` → `OverrideService.assignTicket`, which never touched `intraday_insertions`.
Only two paths closed an `ESCALATION_REQUIRED` row: `moveTickets` (#288) and the Intra-day Queue's own
`manualAssign`. And `escalationsOpen` filters on that status alone, so the row stayed on the read
exactly as long as nothing wrote to it.

## Root cause verified against the tree, and one thing the issue asked to be checked

Confirmed in the working tree before editing:

- `ActionsBand.tsx:955` is the strip's Assign door and calls `apiAssignTicket` — so `assignTicket` is
  the code path, as the issue states.
- `assignTicket`'s transaction writes the batch row, the ticket, the outbox — and nothing on the
  insertion ledger.
- **`assignLane` does not route through `assignTicket`.** The issue said "verify, don't assume", and
  the answer is no: `assign-batch` (the Assign-mode draft commit, and `assignPlants` behind it) is a
  separate per-SE transaction with its own re-read-under-lock write loop, deliberately not sharing
  `assignTicket`'s insert-and-catch shape (#275/#265). It needed its own stamp; a fix in `assignTicket`
  alone would have left the Console's other assign door silently broken.
- `criticalNeedsYou` is literally `escalations.length` (`dispatch-today-query.service.ts:493`), so the
  write fix clears the count and the rows together and no read change was needed — the issue's
  preferred outcome.

**The one regression check that came back negative** is recorded below and filed as its own issue.

## What was built

Two `updateMany`s, each inside the transaction that makes the assignment it belongs to. No schema
change, no read change, no frontend change.

**`assignTicket`** — stamps any open `ESCALATION_REQUIRED` row for the ticket to `ACCEPTED` with
`offeredSeId` = the assignee and `respondedAt` = the call's `now`, verbatim the treatment `moveTickets`
already gives (`override.service.ts:1149`) and for the reason its comment states: an escalation nothing
can clear leaves the queue and the strip asking for a decision already taken, and #268's re-escalation
guard keys on a row no door can close.

**`assignLane`** — one stamp per lane, scoped to `assignedTicketIds`, inside the lane's own
transaction. Per lane rather than per ticket because the assignee is the only value that varies and it
does not vary within a lane; scoped to the tickets actually written because a ticket that came back
`alreadyAssigned` or `LOST_RACE` resolved nothing *here* and must keep its escalation.

**`updateMany` guarded on the status, never a bare `update`.** A concurrent `manualAssign` on the same
insertion must not be double-responded; the guard makes whichever writer arrives second a no-op rather
than an overwrite of the first one's actor and instant.

**`assignedScheduleId` / `assignedBatchId` are deliberately not set here**, though both are in scope
inside the transaction. `moveTickets` does not set them, nothing in the codebase reads them (verified
by grep — six write sites, no readers), and `manualAssign` still sets them on its own path, so its
behaviour is byte-identical. Writing them would have been new surface for no decision.

## A negative regression check, filed rather than folded in

The issue asked to "confirm the cube reads creation, not current status" before closing rows as
ACCEPTED. **It does not.** `system-efficiency-aggregation.service.ts:226-231` counts
`auto_escalations` as `WHERE updated_at BETWEEN dayStart AND dayEnd AND status = 'ESCALATION_REQUIRED'`
— current status, in a window keyed on the *resolution* instant. An escalation raised and resolved on
the same day therefore drops out of the metric entirely. The sibling cross-zone leg four lines above
reads `created_at` with no status filter, which is the correct shape; the disagreement between two
adjacent legs of one metric is what makes this drift rather than a decision.

This **predates #298**: `moveTickets` (#288) and `manualAssign` already flipped rows to `ACCEPTED`, so
the cube was already lossy for every escalation a manager resolved the same day. #298 does not create
it — it makes the most common door hit it. Closing escalations is the correct behaviour and the metric
is what needs fixing, so the slice landed and the metric got its own owner:
[#333](../../.scratch/fsm-platform-v1/issues/333-auto-escalations-cube-counts-current-status.md)
(reporting-only, independent, with the recompute decision as an explicit AC).

## Tests — 6 backend + 1 admin, red before green

`test/assign-closes-escalation.e2e-spec.ts`, new. The escalation is produced by the **real** writer:
`IntradayInsertionService.assignCriticalForZone` over a zone whose only eligible SE is at capacity —
the #258 Q-B path, which leaves the ticket UNASSIGNED, which is precisely the state in which the strip
offers "Assign this work →". Hand-writing the insertion row would have been the #297 mistake in a new
place: `insertionType`, `offeredSeId: null` and `acceptanceDeadline: null` are written together, and a
fixture is free to get that combination wrong in a way production cannot.

1. **AC1, `assignTicket`** — the round trip no existing suite ran: escalate, assign, then ask the
   cockpit. The row is `ACCEPTED` with the assignee and the instant; `escalations` no longer contains
   the ticket; `criticalNeedsYou` drops by exactly one and still equals `escalations.length`.
2. **AC1, `assign-batch`** — the same assertion through the lane path that does not route through
   `assignTicket`.
3. **Lane scoping** — a lane holding one already-assigned ticket and one it really writes closes only
   the second one's escalation.
4. **AC2** — an assign that loses the race and rolls back closes nothing. Driven by a real P2002 on
   `batch_assignment_tickets_one_active_per_ticket` (which per #265 aborts the whole transaction — the
   rollback under test, and the reason the stamp had to be inside it), not by mocking. It asserts the
   *winning* assign closed the row first, so the test fails when the stamp is missing entirely rather
   than passing trivially on the defect.
5. **AC3** — removing the ticket from a plan does **not** close the escalation (#288's recorded rule);
   the strip then shows it with no holder, i.e. offering Assign; and taking that door is what closes
   it. This is the case that makes the strip's two verbs mean different things.
6. **The two doors racing on one row** — console `assignTicket` vs queue `manualAssign`, asserting
   exactly one responder and that the recorded responder is the engineer who actually got the work.
   Explicitly a **start-together race, not a barriered one**: neither call exposes an injection point
   at the contended write, and the harness's own guidance is to say so rather than claim an overlap the
   test does not create. The invariant holds by construction, not by timing — the losing `assignTicket`
   returns `ALREADY_ASSIGNED` before opening a transaction, and `manualAssign` returns early on that
   outcome without reaching its own update.

`test/todays-dispatch.test.tsx` gains one admin test: the strip is driven through the page's real
"Refresh the operating day" control over a payload where the row has gone, and must disappear with it.
The frontend needed no change, but the operator's complaint had two possible causes — a backend that
never closed the escalation, or a console holding the strip past a refetch — and this is the half that
rules out the second. A second `render` would only re-prove that the first paint reads the payload,
which is already asserted; only a refetch on a live page shows the strip is not sticky.

**A fixture bug worth recording**, because `tsc --noEmit` did not catch it: the spec's first `afterEach`
called `prisma.dayPlanOutbox.deleteMany` — a model that does not exist under that name — which threw
and skipped the rest of the reset, leaving capacity-carrying engineers behind and silently converting
the next test's escalation into an assignment. Typecheck passed regardless. The reset is now keyed on
the **zone** rather than on a bookkeeping array, so one throw cannot leave a candidate SE alive for the
next test.

## Verification

- Backend `tsc --noEmit`: clean. Admin `tsc --noEmit`: clean.
- New spec: 6/6 green. With both stamps removed: 5 failed / 1 passed — and the one that still passed
  is why AC2 was tightened, after which the whole file is red without the fix.
- Affected-surface sweep, 16 specs / 101 tests, all green: `assign-batch`,
  `assign-batch-acting-scope`, `assignable-work`, `assign-console-candidates`,
  `assignment-add-provenance` (+ `-writers`), `critical-assign`, `cross-zone-escalation`,
  `intraday-critical-insertion`, `intraday-insertions-controller`, `i1-repeat-escalated-guard`,
  `repeat-escalation`, `se-unavailable-stranded-work`, `dispatch-today-read`,
  `issue-122b-fleet-assign`, `deferral-override-confirm`.
- Admin full suite: 119 files / 820 tests green.
- Full backend suite: see the INDEX session-log row for this date.

## Deliberate omissions

- `escalationsOpen`'s filter is unchanged, per the issue's boundary: the write fix alone satisfies AC1,
  and a read-side filter would alter what the Intra-day Queue shows, which is its own decision.
- The #268 re-escalation guard and `insertion_type` semantics are untouched.
- The `auto_escalations` metric is **not** fixed here — see #333 above. Folding a reporting change with
  a historical-recompute question into a P1 write fix would have made both harder to review.
