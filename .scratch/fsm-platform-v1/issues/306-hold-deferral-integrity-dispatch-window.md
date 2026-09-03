# 306 — Hold/deferral integrity across the dispatch window
Status: **done** (2026-09-02) — report [`docs/progress/306-hold-deferral-integrity-dispatch-window.md`](../../../docs/progress/306-hold-deferral-integrity-dispatch-window.md). The stated policy was taken as written (holds win; skip, never override) — nothing disputed, no escalation needed. Dispatch skips at **two** points, and the distinction matters: a read-time filter after the claim (so the SUGGESTED row is still claimed and retired with its siblings — excluding it at the claim's WHERE would leave the poisoned-ledger residue #126 exists to prevent), plus a guarded ticket write that is the actual guarantee, moved **before** the batch-row insert so a loser leaves no row to explain.
Type: AFK
Wave: 2 · Severity: P2 · Findings: RC-6 + RC-7 (one invariant, two writers),
`audit/2026-09-01-scheduler-engine-forensics.md` §8

## Problem

Two sides of one invariant — "a live deferral and a live assignment cannot coexist, and dispatch
must respect holds" — are both violable:

1. **RC-6 (hold side):** `placeHold` can land a live `deferred_until` on already-assigned work.
   If that ticket is later REMOVEd to the pool, the stale date silently holds it out of every run.
2. **RC-7 (dispatch side):** a hold/deferral placed between the recommender's SUGGESTED write and
   the per-SE dispatch transaction is silently erased (`deferredUntil: null`, unconditional), with
   an audit trail showing a hold placed and no record of it being overridden — and a ticket
   **closed** in the same window still lands on a day plan (recycled only at the 04:00 closure).
   Windows recur daily at exactly the moment operators use the preview screen (pre-run).

## Root cause

- `scheduler-preview.service.ts:169-216`: the OPEN+UNASSIGNED check (:178-180) is a plain read;
  the write (:214) is keyed on primary key only — the repo's guarded-write idiom
  (`stampOnceOrLose` / guarded `updateMany`) is not applied.
- `batch-assignment.service.ts:168-175`: the SKIP-LOCKED claim re-checks only "already has a live
  batch row"; `:279-284` updates the ticket by primary key, unconditionally clearing
  `deferredUntil` and setting `FORMALLY_ASSIGNED` with no `status`/`assignmentState`/deferral
  predicate.

## Policy (stated, from the existing contract — not a new rule)

Holds win over the engine: #251's contract says a hold is "a date the existing `notDeferredOn`
predicate already respects", and every *manual* door already needs confirm+reason to break one
(#249). Dispatch therefore skips a ticket that is deferred-for-the-day, non-OPEN, or non-UNASSIGNED
at claim time — a counted skip, never a silent override. If this reading is disputed, stop and
escalate (Strategic HITL: business rule); do not invent a third behavior.

## Affected files / symbols

- `apps/backend/src/scheduling/scheduler-preview.service.ts` — `placeHold` (and `releaseHold` for
  symmetry review)
- `apps/backend/src/scheduling/batch-assignment.service.ts` — the claim join (:168-175) and the
  ticket update (:279-284)

## Intended behavior after fix

- `placeHold`'s write carries `status: 'OPEN', assignmentState: 'UNASSIGNED'` in its WHERE
  (guarded `updateMany`); count 0 ⇒ the documented refusal shape (the ticket changed under you),
  never a silent success.
- Dispatch's per-SE transaction re-verifies each claimed ticket (`status = 'OPEN' AND
  assignment_state = 'UNASSIGNED' AND notDeferredOn(day)`) either in the claim join or as a
  predicate on the ticket update; a failing ticket is skipped with a named reason, its SUGGESTED
  row released/RETIRED, the rest of the SE's plan unaffected.
- Dispatch still clears `deferredUntil` when it legitimately dispatches a ticket **on** its
  deferral-return day (the existing `:283` semantics for due deferrals stay).

## Implementation boundaries

- Two writers, one slice — the invariant is only testable with both sides guarded.
- Do not change `notDeferredOn` semantics, #249's manual-door confirm flow, or `moveTickets`'
  deliberate deferral-preservation.
- Past-date *validation* on hold/defer inputs is #310, not here.

## DB / API / frontend impact

DB: none. API: `placeHold` may newly return its refusal shape in a race (honest, existing shape);
run summaries gain a named skip reason (additive). Frontend: none (existing refusal handling).

## Dependencies

Sequence with #303/#304/#305/#307 (same `batch-assignment.service.ts`). Independent of Wave 1.

## Regression risks

- The dispatch-side predicate must not skip due-deferral tickets the recommender legitimately
  selected on their return day — the predicate is `notDeferredOn(day)`, not `deferredUntil IS
  NULL`.
- P2002-in-tx rules (#265) still apply: any new guarded write must lose by count, not by catch.

## Tests required

- Barrier race: hold placed between SUGGESTED and dispatch → ticket is NOT dispatched, hold
  survives, skip is named; audit shows the hold un-overridden.
- Barrier race: assign vs placeHold → no FORMALLY_ASSIGNED ticket with a live future
  `deferredUntil` (assert the invariant directly across both orders).
- Race: ticket resolved between SUGGESTED and dispatch → not placed on the plan.
- Regression: deferral-return-day dispatch still clears the deferral
  (existing recommender-return-date spec green).

## Acceptance criteria

- [x] AC1 — invariant: no reachable interleaving leaves a ticket FORMALLY_ASSIGNED with a live
      future `deferred_until`. Both writers guarded; asserted from both orders, including the one that
      needs interleaving at the write (`placeHold`'s check and its write are separated by a
      vehicle-report read and a transaction start, so only the WHERE can catch a dispatch in that gap).
- [x] AC2 — a hold placed at any time before the dispatch commit survives it, as a named skip.
      `DispatchSummary.ticketSkips` carries `{ ticketId, reason }`; the audit trail shows the hold
      placed and nothing overriding it, and the SE's other work still dispatches.
- [x] AC3 — a non-OPEN ticket can never be placed on a day plan by the engine. A ticket closed in the
      window is skipped `NOT_OPEN` instead of riding the plan until the 04:00 closure recycled it.

## UI surfaces

n/a.

## Reference

n/a.

## Blocked by

— (sequence with 303/304/305/307 on shared files)
