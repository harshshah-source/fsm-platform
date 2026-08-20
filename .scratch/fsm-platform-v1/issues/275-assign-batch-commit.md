# 275 — Assign Work Console S3: `assign-batch` — one commit, per-engineer transactions, a review diff

Status: ready-for-agent
Type: AFK · Backend + Admin
Decision: #272 **R2** (nothing written until commit), **R5** (overload stated, not gated), **R8**
(per-engineer transactional, per-engineer result)

## Objective

An M→N manual plan commits as one operator action with one reason, lands as one transaction per
engineer, and reports per engineer — so a lane that fails is legible and re-runnable while the rest
stand.

## Current behaviour (verified)

- `assignPlants` (`override.service.ts:450-483`) loops `assignTicket` **ticket by ticket** with no
  enclosing transaction and no dry run. Each `assignTicket` opens its own transaction
  (`:390-436`). A partial failure leaves a partial plan behind one aggregate toast
  (`AssignSePanel.tsx:84-99`).
- There is no multi-engineer write anywhere. Putting two engineers across three plants means running
  the panel twice, with no cross-run memory and no diff.
- Zone scope is enforced **per ticket inside `assignTicket`**, so an out-of-scope plant contributes
  nothing rather than failing the batch — behaviour to preserve, and to make visible in the result.
- `#262` rewrites dispatch onto per-SE transactions with explicit `transactionOptions`. Building this
  write independently would produce a second transaction strategy over the same tables.
- `#265` gives lost manual races clean 409s and first-writer-wins attribution guards. A console that
  makes concurrent manual assignment easy needs that landed first.

## Required change

1. **`POST /api/schedules/assign-batch`** (manager roles, zone-clamped) —
   `{reasonCode, lanes: [{seId, ticketIds: string[]}]}`.
   - **One transaction per lane**, matching #262's shape and `transactionOptions`, not a new one.
   - Returns one result row per lane: `{seId, assigned, alreadyAssigned, skipped: [{ticketId,
     reason}], scheduleId, batchId, result}`. `skipped` carries out-of-zone, deferred-without-confirm
     (#249 `CONFLICT_DEFERRED`), and lost-race cases (#265) **by ticket**, not as a count.
   - Reason is mandatory and recorded; every ticket still writes its own audit row through the
     existing `assignTicket` primitive — this endpoint changes the transaction boundary and the
     reporting, **not** the assignment semantics.
   - A lane that throws does not roll back other lanes.
2. **`assignPlants` becomes a shorthand** that expands plants → ticket ids and delegates to the same
   path. `POST /schedules/assign-plants` keeps its contract and its callers (Device Detail panel,
   Commissioning Cohort) working unchanged — one write implementation, two entry shapes.
3. **Review & commit screen** — the diff, not a confirm dialog: per-engineer coverage used,
   `before → after / capacity`, tier crossings, device and critical counts, plus the ledger's
   "still unassigned after". The mandatory reason field lives here.
4. **Overload is stated in words** at the point of decision (R5 / Q2) and then allowed through — no
   block, no typed confirmation, no extra audit requirement. Pin it with a test so a future
   "helpful" gate fails.
5. **Per-lane result panel** after commit, replacing the aggregate toast on this path.

## Existing code to reuse

`assignTicket` (the primitive — unchanged) · `#262`'s per-SE transaction shape and
`transactionOptions` · `#265`'s 409 shapes and attribution guards · `#249`'s `CONFLICT_DEFERRED`
confirm flow and `DeferralConfirm` component · `AuditService.withAudit` · the console draft model
from #273.

## Data model / API

No schema change. One new POST. `assign-plants` re-implemented on top of it, contract preserved.

## UI surfaces

Admin: `/assign` review-and-commit screen + per-lane result panel. Mobile: none.

## Reference

`docs/ui/desktop/approved-designs/assign-work-console.html` — wireframe 2 in full. The over-capacity
sentence in the footer is copy to match, not paraphrase: it is the Q2 posture written into the screen.

## Acceptance criteria

- [ ] A three-lane batch commits as three transactions; forcing lane 2 to throw leaves lanes 1 and 3
      committed and reports lane 2 failed.
- [ ] Every assigned ticket has its own audit row, identical in shape to a single `assignTicket` —
      the batch endpoint adds no new audit semantics.
- [ ] `POST /schedules/assign-plants` returns a byte-identical `PlantAssignSummary` before and after
      the re-implementation (contract regression pin over the existing Device Detail flow).
- [ ] An out-of-zone ticket appears in that lane's `skipped` with a reason and does not fail the lane.
- [ ] A deferred ticket without `confirm` returns `CONFLICT_DEFERRED` for that ticket only (#249),
      and the console offers the existing confirm flow.
- [ ] Committing to an over-capacity engineer succeeds 200 with **no** confirm step and **no** extra
      audit requirement (Q2 regression pin).
- [ ] The review screen's "still unassigned after" equals the post-commit `assignable-work` total,
      asserted end-to-end.
- [ ] A lost race returns a clean 4xx for that ticket (#265), never a 500 and never a silent skip.

## Tests

Backend: e2e for per-lane isolation, audit-row parity, `assign-plants` contract, zone skip, deferral
conflict, capacity non-gate, lost race. Admin: review-diff rendering, mandatory reason, per-lane
result panel, over-capacity copy present.

## Dependencies / Blocked by

- **#273** — the draft the commit consumes.
- **#262 (hard)** — the transaction shape. Landing this first means writing a second strategy and
  then reconciling it.
- **#265 (hard)** — clean 409s and attribution guards; the console multiplies concurrent manual
  writes.
- **#249** — already landed; its confirm flow is reused, not re-invented.
- #274 is **not** a prerequisite: the commit works without the candidate column, it is just less
  informed.

## Risks

**High — this is the riskiest issue in P9.** It re-implements the write path every existing manual
assignment flows through. The `assign-plants` contract pin and the audit-row parity AC are the two
that must not be softened; if either becomes hard to satisfy, stop and surface it rather than
loosening the assertion.

## Rollback

Keep `assignPlants`' original implementation behind the same signature until the contract pin has run
green against the real Device Detail flow. Reverting the endpoint leaves the console committing
per-lane through `assign-plants` as in #273.
