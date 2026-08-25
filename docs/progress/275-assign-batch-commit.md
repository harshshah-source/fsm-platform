# #275 — Assign Work Console S3: `assign-batch` (TDD completion report)

**Date:** 2026-08-24 · **Branch:** `feat/autoplant-integration` · **Type:** AFK · Backend + Admin
**Issue:** [`.scratch/fsm-platform-v1/issues/275-assign-batch-commit.md`](../../.scratch/fsm-platform-v1/issues/275-assign-batch-commit.md)
**Design (authoritative):** `docs/ui/desktop/approved-designs/assign-work-console.html` — wireframe 2,
the commit review.
**Sequenced as:** P9 slice 4 of 6 (highest risk in P9), behind #273 ✅ · #262 ✅ · #265 ✅ · #249 ✅.

> Frozen once written, per the progress convention. Corrections go to INDEX / SYSTEM-STATE.

## What was wrong

`assignPlants` (`override.service.ts`) looped `assignTicket` ticket by ticket with no enclosing
transaction and no dry run — a partial failure left a partial plan behind one aggregate toast. There
was no multi-engineer write anywhere: putting two engineers across three plants meant running a panel
twice, with no cross-run memory and no diff. Nothing recorded *why* a manual plan was made.

## The transaction-boundary problem the issue's own text didn't spell out

"One transaction per lane, matching #262's shape" and "every ticket still writes its own audit row
through the existing `assignTicket` primitive" read as compatible until #265's own finding is taken
seriously: **a P2002 aborts the whole interactive transaction.** `assignTicket` handles this today by
opening its *own* transaction per ticket and letting the caller retry from outside. Reusing that shape
literally — calling `assignTicket` N times inside one shared lane transaction — doesn't produce N
sub-transactions; it produces N independent transactions on N connections, which is not "one
transaction per lane" at all, and doesn't compose with a shared `tx` client in the first place.

So `assignTicket` was not reused as a call; its *logic* was, rebuilt as `assignLane` — a new private
method that takes an open `tx` and walks every ticket in the lane inside it. The risk #265 flagged
(a P2002 poisoning the whole lane) is closed structurally rather than caught: each ticket is checked
with a plain (unlocked) read first for the ordinary skip reasons (not found, out of zone, already
assigned, deferred), and only a ticket that looks writable is re-verified with `FOR UPDATE ... SKIP
LOCKED` immediately before the write. A row currently held by a concurrent writer is simply invisible
to that query — never a Postgres error, so the shared transaction is never at risk of a collision-caused
abort. This is the same idiom `dispatchForSe` (#262) already uses for per-SE claiming, not a new one.

## Two engineering calls the issue's literal text didn't settle, made and written down here

1. **`batchId` (singular, per the issue text) → `batchIds` (plural, as built).** A lane routinely spans
   more than one plant — every console lane can — and each plant is its own
   `plant_batch_assignments` row. Returning one id would be wrong on the common case, not the edge
   case, so the lane result carries `batchIds: string[]`.
2. **Where does the mandatory reason live?** "Every ticket still writes its own audit row... this
   endpoint adds no new audit semantics" and "reason is mandatory and recorded" are only both true if
   the reason is *not* smuggled into the per-ticket audit row. It is instead one `ASSIGN_BATCH_COMMIT`
   row per lane — written once, even for a lane that ends up assigning nothing (every ticket skipped or
   already done) — separate from each ticket's own row, which keeps the exact shape `assignTicket`
   already produces (`{seId}` metadata, same action vocabulary family).

## `assignPlants`'s byte-parity needed one fold the new endpoint deliberately doesn't do

`assignLane` itemises a lost race into `skipped` with its own reason (#275's own requirement for the
new endpoint — an operator should see *which* ticket needs a second look). `PlantAssignSummary` predates
that vocabulary: it has one number, `alreadyAssigned`, that the old per-ticket loop incremented for
every `ALREADY_ASSIGNED` outcome, races included. So the `assignPlants` shorthand folds a lost race back
into `alreadyAssigned` for its own response — not because the information doesn't exist, but because
the pre-#275 contract has nowhere honest to put it and the contract-pin AC requires the arithmetic to be
byte-identical, not merely "as informative or more."

`NOT_FOUND` / `OUT_OF_ZONE` / `CONFLICT_DEFERRED` stay silently dropped from `assignPlants`'s counters,
exactly as the old per-ticket loop dropped them — the plant's own "vanished" gap
(`openUnassigned − assigned − alreadyAssigned`), unchanged. In practice `CONFLICT_DEFERRED` cannot
actually fire on this path: the plant read that feeds `assignPlants` (`assignableTickets`) already
excludes deferred tickets, so the check inside `assignLane` is dead code for this caller specifically —
kept anyway because it is live for `assign-batch`'s other caller, the console.

## The review screen's "still unassigned after" needed a real backend seam, not client arithmetic alone

The console drafts by **plant** (unchanged from #273); `assign-batch` writes by **ticket**. Closing that
gap needed a new read: `AssignableWorkQueryService.ticketIdsForPlants` (+ `GET
/schedules/assignable-tickets`), sharing the exact `assignableTickets` predicate the pool and the write
already share, so the ids resolved for the review screen can never disagree with the count the pool
showed. An end-to-end test (`assign-batch.e2e-spec.ts`) pins that the review screen's own
`openTotal − committingTotal` arithmetic equals the real post-commit `assignable-work` total, not just
that the two happen to agree by construction.

## AC found to be under-specified: the deferred-ticket confirm

The AC says a skipped `CONFLICT_DEFERRED` ticket should let "the console offer the existing confirm
flow" — `assign-batch` deliberately carries no per-ticket confirm (the mandatory reason is for the
*plan*, not a hold override, and #249's confirm needs its own reason per hold). The results panel
itemises every skipped ticket by reason and, for a `CONFLICT_DEFERRED` one, offers a **Resolve hold**
action that reuses `apiAssignTicket` + `DeferralConflictError` + `DeferralConfirm` exactly as
`CriticalQueue.tsx` already does — a second call to the existing single-ticket `/schedules/assign`
route, entirely outside the batch that already committed or already reported.

## Verification

- Backend: full suite, 4 foreground chunks — **415 files / 2094 tests (5 skipped, pre-existing env-gated
  book8 dataset spec), 0 failed.** New: `test/assign-batch.e2e-spec.ts` (9 tests — per-lane isolation,
  audit-row parity, zone skip, deferral skip, capacity non-gate, an unbarriered lost-race pair
  (start-together, per #265's own precedent — the invariant asserted is "exactly one winner, never a
  throw", not a specific interleaving), the `assignPlants` delegation, and the end-to-end ledger pin).
  Extended `test/schedules-route-conflicts.e2e-spec.ts` with the new routes' validation + wiring.
  `issue-122b-fleet-assign.e2e-spec.ts` (the pre-existing `assign-plants` contract pin) reruns green
  unmodified.
- Admin: full suite — **106 files / 558 tests, 0 failed** (one pre-existing unrelated
  `TicketDetailDrawer.tsx:440` runtime fault reported by every recent handoff — not a test failure).
  `assign-console.test.tsx`'s old direct-commit test replaced with four review-screen tests (diff
  rendering + mandatory reason, per-lane result reporting, over-capacity copy, back-to-draft) plus the
  deferral-resolve flow; `assign-console-candidates.test.tsx` updated for the renamed entry button
  (`Commit` → `Review & commit`).
- `tsc --noEmit` clean on both `apps/backend` and `apps/admin`.
- No schema change, no new migration.

## What's next

P9 is 4 of 6 done (#272–#275). Remaining, strictly sequential: **#276** `assign-console-distribute`
(several plants × several engineers through #250's existing dry-run seam) · **#277**
`absorb-orphaned-assignment-surfaces` (orphaned `CriticalQueue`, `available-ses`, the never-built
intra-day manual-assign modal, `PlannerPage` names).
