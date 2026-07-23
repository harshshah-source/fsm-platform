# 146 — ZM override integrity: `DEFER_TICKET` is write-only and `REMOVE_TICKET` has no exclusion memory
Status: ready-for-agent
Progress: **slices 1-3 of 5 done** (`0d17842`, `0b77bdd`) — AC 1/2/3/4/7/9 met; AC 5+6 (slice 4 — B2, untouched), AC 8 (slice 5 — admin parity) open. See `docs/progress/146-zm-override-integrity.md`.
Type: AFK

> Source: `docs/audits/2026-07-22-full-project-audit.md` §5 B1 (incl. c3) + B2, re-verified still-open
> by `docs/audits/2026-07-22-adversarial-review-admin-backend.md` §2. Follow-up to
> [#13](./13-zm-monitoring-override.md) — parent stays **accepted** per the accepted-with-follow-up rule.

## Background

The ZM override engine is the **only** human correction mechanism over an auto-dispatch engine that
runs with **no approval gate**. CONTEXT.md:650: *"System-generated Plant-wise Batch Assignments are
dispatched directly to the SE Day Plan as Formal Assignments — there is **no Zonal Manager approval
gate**… The Zonal Manager can override post-hoc: swap SE, split batch across SEs, remove specific
Tickets, **defer Tickets**, reorder work, or reassign."*

Issue 13 AC (`:28`) is marked `- [x]`: *"Swap / Split / Remove / Reorder / **Defer** / Reassign each
commit immediately and flip status to `OVERRIDDEN`."* Two of those six actions do not do what they say.

## Problem

- **B1 — `DEFER_TICKET` is write-only.** `deferredToDate` has a writer and no reader anywhere.
- **B2 — `REMOVE_TICKET` has no exclusion memory.** Removal records *that* a ticket was removed, never
  *from whom*, so the next dispatch run can hand it straight back to the same SE.

## Root Cause

**B1:** the write at `override.service.ts:182` was never paired with a read. Verified exhaustively —
`deferredToDate` across `apps/backend/src` (excluding `src/generated/`) has exactly **three hits, all
in `override.service.ts`**: the command type `:21`, the audit payload `:175`, the write `:182`.
**Zero readers.**

**B2:** the idempotency guard excludes only *live* rows — `batch-assignment.service.ts:90` filters
`removedAt: null` — so a removed ticket is fully re-eligible. **[#127](./127-dispatch-per-se-isolation.md)'s
APPEND change made this bite:** before APPEND, a same-day second dispatch run P2002'd and rolled back
the whole zone, so removals survived *by accident*. APPEND makes the second run succeed, and the
removal is now silently reversible within the same day.

## Evidence

**B1 — three independently verified consequences** (all re-read 2026-07-22):

1. **Stays on today's plan.** No read anywhere filters `deferredToDate` — verified across
   `day-plan-query.service.ts:52`, `zm-schedule-query.service.ts:99,130`, and
   `dispatch-transparency-query.service.ts:357,373,494`. All filter `removedAt: null` only.
2. **Never re-dispatched — and the ticket is stranded permanently, not until the deferred date.**
   `deferTicket` does not touch `assignmentState`, so the ticket stays `FORMALLY_ASSIGNED`; the
   recommender selects `status: 'OPEN', assignmentState: 'UNASSIGNED'`
   (`recommender.service.ts:103-108`) and can therefore **never** pick it up again.
3. **Burns capacity today.** `committedDayLoad` counts `batchAssignmentTicket WHERE removedAt: null`
   (`recommender.service.ts:548-555`) — a deferred ticket occupies one of the SE's 25 slots for a day
   on which it will not be worked.

**B2:** removal writes `removedAt`/`removedBy` and flips the ticket to `UNASSIGNED`
(`override.service.ts:144-149`) — deliberately, "returned to the Shared Pool". Nothing records which
SE it was removed from. The recommender re-selects it (`OPEN` + `UNASSIGNED`) and the idempotency
guard (`batch-assignment.service.ts:86-94`) excludes only tickets with a **live** batch row.

**Live exposure: 0 rows** for both (`deferred_to_date IS NOT NULL` = 0, `removed_at IS NOT NULL` = 0,
prior audit 2026-07-22 — **not re-probed this session; treat the count as of that date**). Both
defects are **latent**, which is precisely why tests are the only available proof.

## Current Behaviour

A ZM defers a ticket → **200 OK, an audit row, and an `OVERRIDDEN` badge** — and nothing happens. The
ticket stays on today's plan, keeps burning a capacity slot, and is never re-planned on any future
date. The control reports success while doing nothing.

A ZM removes a ticket from an SE → the next dispatch run may assign it straight back to that same SE.

## Expected Behaviour — settled, not a product call

`docs/workflow/fsm-business-technical-workflow.md:711`:

> `| **Defer Ticket** | Ticket pushed to a specific future date; removed from current batch |`

Two clauses, both mandatory: **removed from the current batch** *and* **pushed to a specific future
date**. Reinforced by CONTEXT.md:229 (defer listed among audited override actions) and by
`zm_performance_summary_monthly.deferrals` (CONTEXT.md:521, workflow:1681) being a **graded ZM
scorecard metric** — an unobservable field cannot be counted.

> **This overturns the audits' framing.** Both prior audits called defer semantics *"a business-rule
> call, not an engineering one"* and made it a HITL gate. It is documented in the tier-3 authority doc
> (business workflow) and consistent with tier-1 (CONTEXT.md). The prior audit's option **(a)**
> (*defer = remove-with-a-date*) is simply what the docs already specify. **No HITL gate — this issue
> is `ready-for-agent`.**

**B2 is genuinely narrower and stays narrow.** "Return to the shared pool" is the documented intent,
and re-assignment to a *different* SE is correct. The defect is only that nothing prevents
re-assignment to the SE the ZM just removed it from. Fix as a **soft negative preference**, mirroring
the existing SE-Planner soft-bias mechanism (**ADR-0022**) — no new concept, and a hard filter would
contradict the shared-pool return.

## What to build

Give `DEFER_TICKET` the semantics the workflow doc specifies, stop it burning capacity, and give
`REMOVE_TICKET` a same-day soft negative preference for the SE it was removed from.

## Acceptance criteria

- [x] A deferred ticket **disappears from the current day's** SE day plan, ZM schedule view, and dispatch-transparency reads.
- [x] A deferred ticket **does not consume** SE capacity for the current day (`committedDayLoad` excludes it).
- [x] A deferred ticket becomes re-dispatchable **on `deferredToDate` — not before, and not never**: it re-enters the recommender's candidate set on that date.
- [x] Capacity and scoring for non-deferred tickets are **byte-identical** to today, pinned by a regression test with zero deferred rows.
- [ ] After a `REMOVE_TICKET`, the same-day recommender **de-prioritises** the SE it was removed from; with no alternative SE, that SE is **still** assigned (soft, not hard — shared-pool intent preserved).
- [ ] The soft bias is expressed through the ADR-0022 mechanism, not a new concept, and appears in `scoreBreakdown` so [#123](./123-batch-assignment-transparency.md)'s transparency panel can explain it.
- [x] `deferrals` remains countable for the ZM Performance Scorecard.
- [ ] Admin batch-schedule-detail (`/schedules/:engineerId`) reflects a deferred ticket's new state — parity gate satisfied **in-slice**, not deferred.
- [x] Backend suite green; the #127 APPEND and #126 zone-wedge regressions stay green.

## TDD Strategy

**Strict TDD — this is the highest-value TDD on the roadmap.** Every acceptance criterion is a
behavioural assertion on the dispatch hot path with **0 live rows**, so production cannot demonstrate
the bug and tests are the only available proof.

**Slice 3 RED (the decisive one) — `dispatch-defer-lifecycle.e2e-spec.ts`:**

- **Test:** seed an SE with a dispatched batch; `POST /schedules/:id/override`
  `{action:'DEFER_TICKET', ticketId, deferredToDate: tomorrow, reasonCode}`; run `dispatchForZone`
  for **today** → assert the ticket is **absent** from every produced batch; advance to **tomorrow**,
  run again → assert the ticket **is** assigned.
- **What fails today:** the second assertion (the ticket is never re-dispatched). The first also
  fails, for a different reason — the ticket never left today's batch at all.
- **Why it fails:** `deferTicket` never touches `assignmentState`, so the ticket remains
  `FORMALLY_ASSIGNED`; the recommender selects `OPEN` + `UNASSIGNED` (`recommender.service.ts:103-108`)
  and can never re-pick it. The ticket is stranded **permanently**, not until tomorrow.
- **What makes it pass:** a ticket-level `deferred_until` + `removedAt` on the batch row +
  `assignmentState → UNASSIGNED` on defer, and a candidate-query predicate
  `deferred_until IS NULL OR deferred_until <= :today`.

**Slice 4 RED:** removed ticket + two eligible SEs → the **other** SE wins; then with only the
removed-from SE eligible → that SE is **still** assigned. The second assertion is the one that keeps
the fix soft; write both before touching `scoring.ts`.

**Slice 2 pins existing behaviour:** the byte-identical DEFICIT regression with zero deferred rows
must be written first and pass immediately. If it fails, the harness is wrong and must be fixed before
any source change.

## Implementation Slices

### Slice 1 — Defer removes the ticket from today's reads

- **Objective:** a deferred ticket stops appearing on today's plan.
- **Files:** `src/scheduling/override.service.ts`, `src/scheduling/day-plan-query.service.ts`,
  `src/scheduling/zm-schedule-query.service.ts`, `src/scheduling/dispatch-transparency-query.service.ts`
- **Services:** `scheduling`.
- **Database:** none.
- **Frontend:** none.
- **Tests:** defer a ticket → absent from all three reads; a non-deferred ticket in the same batch is
  unaffected.
- **Acceptance criteria:** AC 1.
- **Definition of Done:** all three reads consistent; scheduling suite green.

### Slice 2 — Defer stops burning capacity

- **Objective:** a deferred ticket frees its slot.
- **Files:** `src/recommender/recommender.service.ts:548-555`
- **Services:** `recommender`.
- **Database:** none.
- **Tests:** SE at 24/25 with one deferred → next run may assign; **byte-identical DEFICIT regression
  with zero deferred rows** (written first, passes immediately).
- **Acceptance criteria:** AC 2, 4.
- **Definition of Done:** capacity correct in both directions; recommender suite green.

### Slice 3 — Defer re-dispatches on the deferred date

- **Objective:** close the permanent-stranding bug.
- **Files:** `prisma/schema.prisma` + migration (`deferred_until`),
  `src/scheduling/override.service.ts`, recommender candidate query.
- **Services:** `scheduling`, `recommender`.
- **Database:** additive ticket-level `deferred_until` column (the batch row is per-plan and is being
  removed from the current batch, so it cannot carry the future date).
- **Tests:** the `dispatch-defer-lifecycle` spec above.
- **Acceptance criteria:** AC 3, 7.
- **Definition of Done:** from-zero migrate no drift; stranding provably closed.

### Slice 4 — `REMOVE_TICKET` soft negative preference (B2)

- **Objective:** a removed ticket does not bounce back to the same SE the same day.
- **Files:** `src/scheduling/override.service.ts`, `src/recommender/scoring.ts`,
  `src/recommender/recommender.service.ts`
- **Services:** `scheduling`, `recommender`.
- **Database:** record the removed-from SE (reuse the existing row or add `removed_from_se_id`).
- **Tests:** the two assertions above (prefers the other SE; still assigns when alone).
- **Acceptance criteria:** AC 5, 6.
- **Definition of Done:** `scoreBreakdown` shows the penalty; ADR-0022 pattern reused, no new concept.

### Slice 5 — Admin parity

- **Objective:** the ZM can see what their defer did.
- **Files:** `apps/admin/src/pages/` batch-schedule-detail.
- **Frontend:** deferred state + date on the stop row.
- **Tests:** admin spec asserting the deferred row renders its state and date.
- **Acceptance criteria:** AC 8.
- **Definition of Done:** parity gate satisfied in-slice; admin suite green.

Slices 1–2 are independently mergeable and each strictly improve correctness. Slice 3 depends on 1.
Slice 4 is independent of 1–3. Slice 5 depends on 3.

## Rollback Plan

Additive migration (`deferred_until` nullable) — safe to leave in place on revert. The recommender
predicate (Slice 3) and the scoring weight (Slice 4) are independently revertible. **Ship B1 (Slices
1–3, 5) and B2 (Slice 4) as separate commits** so one can be reverted without the other.

## Dependencies

**Blocked by [#144](./144-commit-dispatch-correctness-layer.md)** — `batch-assignment.service.ts` and
`recommender.service.ts` are both currently dirty. Building on an uncommitted base repeats exactly the
failure #144 exists to close.

Sequence before [#147](./147-day-plan-date-filter-schedule-closure.md) (no hard dependency; both touch
`scheduling`, so sequential merge avoids conflicts).

## Estimated Effort

1–2 days (S/M). **Priority: P2.**

## UI surfaces

Admin: **Batch Schedule Detail** (`/schedules/:engineerId`) — deferred-ticket state + date on the stop
row (PRD:324 names this surface as carrying the override/defer controls).
Mobile: SE Day Plan is affected *by construction* (a deferred ticket simply stops being returned) —
no mobile screen change is needed and none is deferred; the mobile client itself is
[#54](./54-mobile-foundation.md).

## Reference

- `docs/ui/desktop/v2-reference/12-batch-schedule-review.png` (batch schedule detail + override controls)

## Blocked by
- [#144](./144-commit-dispatch-correctness-layer.md)
