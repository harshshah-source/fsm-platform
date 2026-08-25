# #288 — An SE who becomes unavailable mid-day does not silently strand their work

**Landed 2026-08-25.** Owning decision:
[#282](../../.scratch/fsm-platform-v1/issues/282-decision-todays-dispatch-crew-deck.md) R4 —
**escalate-only. Nothing re-plans automatically.**

## What was wrong

Nothing re-planned committed work when availability changed. `LeaveRequestService.approve` wrote an
`se_availability` window, and that window only affected the **next** selection pass — so an engineer
who went on leave at 11:00 kept a full afternoon of work on a plan nobody was going to execute, and
nothing anywhere said so.

Worse, the documented recovery path for this had been deleted. `hard-filters.ts` retires the ADR-0016
heartbeat filter and points at "Acceptance Timeout + reroute (Issue 29/30)" — machinery **#268
removed** when it retired the SE-acceptance step. No replacement was ever filed. This is the
replacement, in the shape the operator chose.

## What landed

`src/intraday/stranded-work-escalation.service.ts` — for one engineer and one operating day, raise an
`ESCALATION_REQUIRED` row per live remaining ticket and alert the zone's ZM once.

It is hooked to **`SeAvailabilityService.setAvailability`**, not to `LeaveRequestService.approve`.
Approval delegates to that write, and so does a manager or an SE setting a window directly — hooking
the delegate covers every door with one rule, and two hooks would have been two definitions of
"unavailable". `now` is threaded through `setAvailability` and `approve` because the write now has a
time-dependent consequence: leave that covers today escalates, leave booked for next month does not,
and a clock read inside the service would make that difference untestable at a fixed instant.

## Decisions worth recording

**"Remaining" re-uses two existing facts rather than inventing a third.** A live day-plan row
(`removed_at IS NULL` on a live schedule covering the day — `committedDayPlan`'s own predicate, #269's
one definition of committed) whose ticket is still `OPEN`. Work already submitted, verified, closed or
removed from the plan is not work anybody still has to go and do, which is AC2 without a second
notion of "done".

**One alert, many ledger rows.** The queue needs a row per ticket — that is what it lists and what the
re-escalation guard keys on — but the *decision* is single: this engineer's day has to be
redistributed. Eight notifications for eight stops would be the storm the guard exists to prevent,
arriving through a different door. The guard itself (`intradayInsertions: { none: { status:
'ESCALATION_REQUIRED' } }`) is #268's, verbatim, so a second availability write neither duplicates a
row nor re-alerts (AC4).

**`offeredSeId` stays null.** The engineer named in the alert is the one the work is being taken
*from*; writing them into the column that means "who was offered this" would say the opposite of what
happened. That is #268's own reason for the column being nullable.

**Escalating outside the transaction.** The availability window is the decision; the escalations are a
consequence of it. A failure to raise them must not roll back the fact that the engineer is
unavailable — the same posture `IntradayInsertionService.escalate` holds.

## The conflict between AC3 and AC5, and how it is resolved

AC3 says nothing is reassigned and the assignment rows are untouched. AC5 says the escalations are
actionable through the existing manual-assign path. **Those two are not simultaneously true of the
Intra-day Queue's Assign button**, and finding that out was the substantial part of this issue:
`assignTicket` refuses a `FORMALLY_ASSIGNED` ticket with `ALREADY_ASSIGNED` (#265's lost-race
hygiene), and stranded work is still formally assigned *precisely because* AC3 requires it. Assign
would have failed on exactly the rows it looked most needed on.

Freeing the work first — removing the plan rows so the tickets go `UNASSIGNED` — was rejected: that is
the automatic re-plan #282 R4 forbids, and it would destroy the plan history the issue asks to keep.

So the resolution is the **other** existing manual path: a reassign on the holder's day plan, which is
a surface that already exists and which, since #289, shows the impact of the move before it is
committed. Making that work required telling the surfaces which case they are looking at:

- `intraday/current-assignee.ts` — one read-time derivation, shared by the queue read and the cockpit
  read, answering "who holds this ticket right now". Read-time, not a stored column: who holds a
  ticket changes with every override, and a stamped copy would go stale silently.
- `IntradayInsertionRow` and `TodayEscalation` carry `insertionType` plus `assignedSeId` /
  `assignedSeName`.
- The Intra-day Queue labels an `SE_UNAVAILABLE` row for what it is, names the engineer who holds the
  work, and offers **"Reassign on the day plan →"** in place of the Assign that cannot resolve it.
- The cockpit's interception strip stops asserting one cause over a mixed list. "No capacity-eligible
  engineer was available" is printed only when it is true of *every* row; each stranded row says who
  is unavailable and links to that day plan.

A spec pins the dead end itself — `manualAssign` on a stranded row returns `ALREADY_ASSIGNED` — so
nobody re-adds the button on the grounds that it looks missing.

## A defect the type-checker and an old fixture found

`isStranded` was first written as `assignedSeId !== null`. Every pre-existing queue fixture carries
**`undefined`** for a field that did not exist when it was written — and `undefined !== null` — so the
Assign button vanished from every capacity escalation in the queue, which three #277 tests caught
immediately. Truthiness, not an identity check, is the honest test for "somebody holds this", and the
same shape of payload will keep arriving from any client that has not refreshed its types.

## Tests

New: `test/se-unavailable-stranded-work.e2e-spec.ts` (8) — AC1 through the real leave workflow; AC2
(submitted work and a removed row are not escalated); AC3 (the batch-ticket row is byte-identical
afterwards, the batch, schedule and `assignmentState` unchanged); AC4 (a second window write neither
re-escalates nor re-alerts); AC5 (the row names the holder, and `manualAssign` refuses it); the two
boundaries (leave starting next week, and a window that gives the day back); the cockpit read carrying
the cause and the holder; and the escalation closing when a human actually moves the work.

Admin: `intraday-queue.test.tsx` (+2) and `todays-dispatch.test.tsx` (+2).

Full backend suite **426 files / 2187 tests, 0 failed** (no #184 worker-crash flake this run), plus a
14-file override/intraday blast-radius re-run after the close-on-move change (80 tests). Admin **112
files / 657 tests, 0 failed**. `tsc --noEmit` clean on both.

## One more thing it had to fix to be honest

An escalation nothing can clear is worse than no escalation. A move — `REASSIGN` / `SWAP_SE` /
`SPLIT_BATCH` — now closes any open escalation for the tickets it moves, inside the same audited
transaction that moves them: that move *is* the decision the row was asking for. `ACCEPTED` is the
terminal value `manualAssign` already writes when a human places escalated work, so this adds no enum
member and no second vocabulary. **Removal is deliberately not a closer**: a ticket taken off the plan
is genuinely unassigned work that still needs somebody, and the read surfaces flip to offering Assign
for it on their own, because nobody holds it any more.

## Not done here

**No sweep.** Escalation happens on the availability write, so an engineer who becomes unreachable
without anybody recording it — the phone-off case the retired heartbeat filter once covered — still
strands work silently. Detecting *that* needs a liveness signal the platform does not have (#258 Q6
rules out live GPS for Phase 1), and inventing one from ping timestamps would resurrect exactly the
filter ADR-0016 retired. Worth its own issue if the operator wants it.

**The SE is not told.** The alert goes to the ZM, which is what AC1 asks for. Telling the engineer
their day was escalated is a mobile-notification question, and the mobile app is an auth shell.
