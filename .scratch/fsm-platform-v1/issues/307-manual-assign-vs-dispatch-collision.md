# 307 — A colliding manual assign no longer costs the SE their whole engine plan
Status: **done** (2026-09-02) — report [`docs/progress/307-manual-assign-vs-dispatch-collision.md`](../../../docs/progress/307-manual-assign-vs-dispatch-collision.md). The recommended design, unchanged: one retry, scoped to `uniqueViolationModel(e) === 'BatchAssignmentTicket'`. No locks added to the manual doors. Landed after #306 as the dependency required, so the retry wraps the final loop shape.
Type: AFK
Wave: 2 · Severity: P2 · Finding: RC-8, `audit/2026-09-01-scheduler-engine-forensics.md` §8

## Problem

A manager's manual assign of ticket T committing inside a per-SE dispatch transaction's window
(after the already-assigned re-read at `batch-assignment.service.ts:182-190`, before the
batch-ticket create) makes the partial unique abort the **whole per-SE transaction** (a P2002
aborts its interactive tx — #265). The SE lands in `seSkips` and `clearFailedSeOrphans`
(`:359-369`) retires all their SUGGESTED rows — one colliding ticket silently discards the
engine's entire plan for that engineer for the run; recovery requires a human noticing the zone
card and pressing Run again. Bulk-unassign deliberately checks the zone claim for exactly this
reason (`bulk-unassign.service.ts:238-243`); manual assigns get no such courtesy.

## Root cause

Manual doors (`assignTicket`/`assignLane`) take no zone advisory lock and never consult
`zone-claim.ts`; the per-SE dispatch tx cannot catch-and-continue a P2002 in place (#265), and no
retry exists at the per-SE level.

## Affected files / symbols

- `apps/backend/src/scheduling/batch-assignment.service.ts` — `dispatchForZone`'s per-SE loop
  (the retry seam), `dispatchForSe`
- Read-only: `override.service.ts` (manual doors unchanged), `zone-claim.ts`

## Intended behavior after fix

Recommended design (report's direction, smallest honest fix): on a `BatchAssignmentTicket`
unique-violation failure of a per-SE transaction, **retry that SE once** — the idempotency guard
(`:182-190`) already re-reads inside the new transaction and will fold the collided ticket out,
so the retry dispatches the rest of the plan. A second failure records the skip exactly as today.
Alternative (blocking manual doors during the per-SE window) is rejected: it would make operator
actions wait on the engine, inverting #258's posture.

## Implementation boundaries

- Retry at the per-SE granularity only; never re-enter a zone. At most one retry.
- `clearFailedSeOrphans` runs only after the final failure, never between attempt and retry.
- Do not add locks to the manual doors.

## DB / API / frontend impact

None (behavioral: fewer spurious `seSkips`; the collided ticket folds into `alreadyAssigned`).

## Dependencies

Sequence with #303/#304/#305/#306 (same file). #306's claim predicates change the same loop —
land #306 first, then this retry wraps the final shape.

## Regression risks

- Retry must be scoped to the discriminated unique violation (`uniqueViolationModel ===
  'BatchAssignmentTicket'`), never to `WorkSchedule` conflicts (those keep today's semantics) or
  generic errors — otherwise real failures loop.
- SKIP LOCKED interplay: the retry's claim must not pick up rows a concurrent claimant holds
  (existing property; assert it).

## Tests required

- Barrier race: manual assign of one ticket mid-window → per-SE tx retries; SE receives the rest
  of their plan; the collided ticket shows `alreadyAssigned`; zero `seSkips` for the SE.
- Double-failure path: second collision → skip recorded exactly as today (pinned).
- Regression: `dispatch-per-se-isolation`, `dispatch-transactional` green.

## Acceptance criteria

- [x] AC1 — one colliding manual ticket costs the engine at most that ticket, never the SE's plan. The
      retry re-enters `dispatchForSe`, whose idempotency re-read runs in the NEW transaction and folds
      the collided ticket out; the rest of the plan dispatches.
- [x] AC2 — the ledger stays honest: retried outcomes are indistinguishable from a clean dispatch
      except for the folded ticket. No `seSkips`, no `orphansCleared`, and the collided ticket appears
      once — as #306's `ticketSkips` entry `ALREADY_ASSIGNED`, on the manager's plan only.
- [x] AC3 — unrelated per-SE failures still skip-and-name exactly as today. Asserted by **counting the
      injections**: a lock timeout fires once, not twice, so it is provably not retried; and a second
      ticket collision exhausts the one-retry budget and reports `TICKET_CONFLICT` as before.

## UI surfaces

n/a.

## Reference

n/a.

## Blocked by

306 (same loop — sequential)
