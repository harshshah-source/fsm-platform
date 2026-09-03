# 327 — Assignment write-path ordering hygiene: lock order + stop-sequence uniqueness
Status: done
Type: AFK
Wave: 4 · Severity: P3 · Findings: RC-12 + RC-13,
`audit/2026-09-01-scheduler-engine-forensics.md` §8

## Problem
1. **RC-12:** lock-order inversion — `assignLane` locks the ticket row first
   (`override.service.ts:858-860`) then inserts the batch-ticket row; `assignTicket` inserts the
   batch-ticket row first (:624) then updates `tickets` (:649). Concurrent execution on one
   ticket can deadlock (40P01 → unhandled 500 / spurious `LANE_FAILED`).
2. **RC-13:** `nextStopSequence`/`nextSortOrder` are `max+1` aggregates with no lock and no
   unique on `(schedule_id, stop_sequence)` (:1247-1255) — concurrent adds can mint duplicate
   stop numbers; `reorder` computes from a pre-transaction read (:456-467). Cosmetic (ordering
   ties), self-healing on reorder.

## Root cause
Two write paths grew independently; ordering was never unified.

## Affected files / symbols
`apps/backend/src/scheduling/override.service.ts` — `assignTicket`, `assignLane`,
`nextStopSequence`/`nextSortOrder`, `reorder`.

## Intended behavior after fix
- One documented acquisition order shared by both paths (align `assignTicket` to lock-then-insert
  or vice versa — pick one, comment it, and map a residual 40P01 to the existing conflict shape
  rather than 500).
- Stop-sequence duplication either prevented (compute under the same in-tx lock) or made
  provably harmless with a deterministic tiebreak in every reader — one recorded choice; a DB
  unique is optional and only if the probe shows no existing duplicates.

## Implementation boundaries
`override.service.ts` internals only; no API shape change; no reorder semantics change.

## DB / API / frontend impact
None expected (optional unique index would be a migration — probe first, #155's rule).

## Dependencies
Sequence after #298/#306/#307/#310/#325 on the same file. Low urgency.

## Regression risks
Reordering acquisition must not reintroduce the #265 P2002-in-tx traps — the existing
lost-race suites are the pin.

## Tests required
Barrier: concurrent assignTicket vs assignLane on one ticket → no 5xx, one winner; concurrent
adds to one schedule → sequences unique or deterministically ordered; `lost-race-hygiene` green.

## Acceptance criteria
- [x] AC1 — no concurrent manual-write interleaving can 500 via deadlock.
- [x] AC2 — stop ordering is deterministic under concurrency, by prevention or by recorded
      tiebreak.

## Outcome — DONE 2026-09-02
Report: `docs/progress/327-assignment-write-path-ordering.md`.

**AC1.** One order, documented above `OverrideService`:
`tickets → work_schedules → plant_batch_assignments → batch_assignment_tickets`. `assignTicket` moved
to match `assignLane` (not the reverse): it is the order the dispatch run already writes in (#306's
"the ticket write comes FIRST"), the ticket row is what every path contends on, and aligning the lane
instead would have unwound #265's `SKIP LOCKED` re-verify — the regression this issue's own risk note
forbids. `assignTicket` opens its transaction with a **blocking** `FOR UPDATE` re-check (not the lane's
`SKIP LOCKED`: a single-ticket assign has no siblings to protect and can afford to wait for the true
answer) and loses via `LostRaceError` → `ALREADY_ASSIGNED`, with the existing P2002 recovery kept as
the backstop.

Residual 40P01s are mapped rather than left to 500 — `isDeadlock` in `common/lost-race.ts`, whose shape
was **measured** (a `DriverAdapterError` with no Prisma `code`; the SQLSTATE is on `cause` alone):
`assignTicket` → `ALREADY_ASSIGNED` (409), `override()` → `NOT_FOUND`, `assignPlants` → the summary
with nothing assigned (that legacy shape has no failure member, so the throw was reaching the
controller as a 500), `assignBatch` → `LANE_FAILED` unchanged.

**The premise "unhandled 500 / spurious `LANE_FAILED`" was right about both halves, and the second is
the quieter defect:** `assignBatch`'s blanket catch reported the deadlocked lane as `LANE_FAILED` with
assigned 0 and **skipped `[]`** — the operator told the lane failed, given nothing to act on, and no
signal separating it from a real failure. The spec asserts the lane result is `OK`.

**AC2 — prevented, not tiebroken.** `lockSchedule` takes the `work_schedules` row before anything under
it, from `ensureSchedule` (the one place all four writers obtain a schedule), both `max + 1` mints, both
renumbering paths and `flagOverridden`; `nextSortOrder` takes the batch row for the same reason.
`reorder` also moved its read **inside** the transaction under that lock (it read the plan it was about
to renumber before the transaction opened, so a stop added in the gap was never renumbered — the very
state reorder exists to heal).

**The optional DB unique was probe-cleared and still rejected.**
`scripts/probe-stop-sequence-duplicates.cjs` (new) against dev `fsm`: zero duplicate groups on
`(schedule_id, stop_sequence)` and on `(batch_id, sort_order)` across 1,579 batches / 7,391 live rows,
so #155's rule permitted one. It is wrong anyway on a ground the probe cannot see: renumbering writes
transient duplicates by construction (`moveBatchToTop` sets the incoming batch to stop 1 while the
outgoing stop still holds 1), so a non-deferrable unique index would refuse the operation that heals
the ordering, and Prisma cannot express `DEFERRABLE`. **No migration; `prisma/drift-baseline.txt`
untouched.**

The forensics called duplicate stop numbers "cosmetic". They are not: seven readers across five
services order by `stop_sequence`, so a tie means two reads of one plan can disagree about the route —
the operator and the engineer looking at different orders for the same day.

**Tests.** `test/assignment-write-path-ordering.e2e-spec.ts` (5). Red first with each defect's own
signature: lane `LANE_FAILED`/skipped `[]`; no ticket lock in the one-click transaction at all; stop
sequences `[1, 1]`; a residual deadlock answering `OK`. Full backend suite **451 files / 2,406 passed /
5 skipped**; the 47-file regression surface (incl. `lost-race-hygiene`) green; `tsc --noEmit` clean.

**Follow-up filed: #334** — the ordering is not total outside this file. The dispatch run writes
`work_schedules` before `tickets`, and cross-schedule moves have no order between source and
destination; both are named, mapped and left, because both live outside this issue's boundary.

## UI surfaces
n/a.

## Reference
n/a.

## Blocked by
298, 306, 307, 310, 325 (file sequence)
