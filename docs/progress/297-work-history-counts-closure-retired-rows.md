# #297 — Work-history counts completions from closure events, not live batch rows (TDD completion report)

**Date:** 2026-09-02 · **Branch:** `feat/autoplant-integration` · **Type:** AFK · Backend
**Issue:** [`.scratch/fsm-platform-v1/issues/297-work-history-counts-closure-retired-rows.md`](../../.scratch/fsm-platform-v1/issues/297-work-history-counts-closure-retired-rows.md)
**Finding:** CB-1, `audit/2026-09-01-scheduler-engine-forensics.md` §6 · Wave 1 / P1 (independent).

> Frozen once written, per the progress convention. Corrections go to INDEX / SYSTEM-STATE.

## What was wrong

The SE Home "Assigned vs Completed" chart showed completed ≈ 0 and `assigned` **shrinking** as work got
done — the inverse of reality, and retroactively, because the #178 backfill stamped historical rows too.

`getWorkHistory` built `assigned(D)` from `tickets: { where: { removedAt: null } }`. That predicate was
right until #178: before it, a resolved ticket's `batch_assignment_tickets` row simply stayed live
forever, so `removed_at IS NULL` meant "was on the plan". #178 made every terminal closure retire the
row inside the closing transaction (`scheduling/close-assignment.ts:42-45`, `TICKET_RESOLVED`), so the
same predicate silently started meaning "on the plan **and** not finished". `completed(D)` is gated on
that day's assigned set (`completed ⊆ assigned`, by design), so a finished ticket dropped out of *both*
series at once.

The sibling live read (`me-tickets-query.service.ts:67`) had been given a same-day compensation for
exactly this. The history read never was.

## Root cause verified against the tree before editing

Both cited lines matched the working tree unchanged (`me-work-history.service.ts:87` and `:124`), and
`retireAssignmentOnClosure` has eight call sites across four closure services plus the backfill script —
verified by grep, not assumed. Nothing in the dirty working tree touched this file or its spec; the one
WIP edit to `removal-reason.ts` is a docblock, adding no vocabulary member.

## What was built

One predicate, in `src/me-tickets/me-work-history.service.ts`. No writer, migration, DTO or frontend
change.

**`CONCLUDED_REMOVAL_REASONS`** — an exported allow-list of the reasons under which a *retired* row
still counts as work the SE was assigned that day:

| Reason | Why it counts |
|---|---|
| `TICKET_RESOLVED` | the ticket reached a terminal state — verification, warehouse receipt, install, non-op, manual recovery |
| `AUTO_RECOVERY` | a real closure; stays in `assigned`, scores 0 in `completed` because `CLOSED_AUTO_RECOVERY` is not a completed state (#229 D6) |
| `RESOLVED_AT_CLOSURE` | the nightly backstop stamping a row left live on an already-resolved ticket (#242) |

Everything else is out: a ZM withdrawal or defer, a reassignment away, a bulk unassign, a cancellation,
a component wait, a plan expiry, a vehicle-unavailable return, the cleanup and backfill markers, and a
removed row carrying no reason at all.

**The split is "did the assignment end because the ticket's life ended, or because the work was taken
off the plan?"** — the distinction `removal-reason.ts` already draws in prose on `TICKET_RESOLVED`
("Distinct from `TICKET_CANCELLED`, where the work was called off from outside: here the work genuinely
finished, successfully or not").

**An allow-list, deliberately** — the same discipline as `COUNTABLE_REMOVAL_REASONS`
(`ticketing/special-ticket.query.ts`). A reason code added later is excluded until somebody classifies
it, because a wrong *inclusion* silently inflates the denominator of an SE's productivity chart, while a
wrong *exclusion* reproduces a failure we already know how to recognise.

**Not `removed_by IS NULL`.** That NULL is the pre-#241 auto-recovery signature and means only "that
one system path" (SYSTEM-STATE §2.4); several other writers stamp a null actor today. The reason column
carries the classification.

`completed(D)`'s gate was left exactly as it was. It reads "is this ticket in that day's assigned set",
and once `assigned` stops deleting finished work the gate admits the closure by construction —
`completed ⊆ assigned` therefore still holds, which is what lets the chart print `4/6` as a fraction.
Changing it would have broken that invariant to fix a symptom of the other predicate.

## Tests — the fixture was the reason this stayed invisible

`test/me-work-history.e2e-spec.ts` used to fabricate closures with a bare `ticketEvent.create`: an event
with the batch row left untouched. Since #178 **no production path can reach that state**, so the spec
was describing a world the system had stopped producing, and it went on passing while the live chart was
inverted. Rewritten so closure state is only ever created by a real writer:

- `closeByVerification` — the SE submits the troubleshooting form (`TroubleshootSubmissionService`), the
  device pings through the window, `VerificationService.runVerification` decides. That transaction
  stamps the `CLOSED` event **and** retires the row. `closedAt` is injected, so the IST-day bucketing
  cases still sit on the exact side of midnight they were chosen for.
- `closeByAutoRecovery` — `AutoRecoveryService.manualClose`, which writes `CLOSED_AUTO_RECOVERY` and
  retires the row with `AUTO_RECOVERY`.

Removal-only state (a ZM withdrawal, a defer, a plan expiry) is still constructed directly on the batch
row, carrying the reason its real writer stamps — that is not closure state, and the reason column is
the contract every one of those writers meets.

Three cases, red before green (each verified failing against the unfixed predicate):

1. **AC1** — three dispatched on 06-19, two finished through verification: `assigned: 3, completed: 2`.
   Unfixed, this read `0/0`. The spec first asserts all four closed tickets have **no live row left**,
   so the fixture cannot pass by failing to reach the state under test. Retains the original day's other
   pins: IST midnight bucketing (a 00:15 IST close counts on the right day), `completed ⊆ assigned` (a
   ticket closed on a day it was not dispatched counts nowhere), dense zero-days, and every bar fitting
   its track.
2. **AC2** — a `PLAN_EXPIRED` recycled row and a `ZM_DEFERRED` row count in neither series, beside a
   resolved sibling on the same day that counts in both.
3. **Regression guard** — every member of `ALL_REMOVAL_REASONS` pinned to a bucket **by name**, one IST
   day per case on an SE of its own, plus the live row and the no-reason row. A failure names the reason
   that moved rather than a total that drifted. Two further assertions keep it honest: the allow-list is
   spelled out literally (widening it is a deliberate edit to that line too), and the case list is
   asserted equal to the whole vocabulary, so a reason added without a bucket fails here rather than in
   production.

**AC3** — no spec in the file creates closure state with a bare `ticketEvent.create` any more.

## Verification

- Backend `tsc --noEmit`: clean. Admin and mobile `tsc --noEmit`: clean (neither app changed).
- `test/me-work-history.e2e-spec.ts`: 6/6 green. Against the unfixed predicate: 3 failed / 3 passed —
  exactly the three cases above.
- Full backend suite: see the INDEX session-log row for this date.
- No admin/mobile code change. `GET /me/work-history` keeps its shape; the chart's numbers correct
  themselves and will jump upward on first load — expected, not a regression.

## Deliberate omissions

- **No time-bounding of a concluded row against the day it is being counted for.** A ticket on a
  multi-day schedule that resolves on day 2 still counts as assigned on day 3 of that schedule. This is
  precisely the pre-#178 behaviour (a never-retired row counted on every covered day), the issue's
  intended behaviour names reasons and not instants, and adding a `removed_at`-vs-day comparison would
  change days the bug never touched. If it is ever wanted, it is a separate slice with its own ACs.
- Writers, the recycler and `me-tickets-query.service.ts` were not touched — the issue's boundary, and
  the live read is already correct.
- No backfill: this is a read-side fix, so historical days correct themselves with no data migration.
