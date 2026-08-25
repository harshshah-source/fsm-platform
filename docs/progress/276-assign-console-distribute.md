# #276 — Assign Work Console S4: Distribute (TDD completion report)

**Date:** 2026-08-24 · **Branch:** `feat/autoplant-integration` · **Type:** AFK · Backend + Admin
**Issue:** [`.scratch/fsm-platform-v1/issues/276-assign-console-distribute.md`](../../.scratch/fsm-platform-v1/issues/276-assign-console-distribute.md)
**Sequenced as:** P9 slice 5 of 6, behind #274 ✅ · #275 ✅ · #250 ✅ · #266 ✅.

> Frozen once written, per the progress convention. Corrections go to INDEX / SYSTEM-STATE.

## RBAC — the one thing that had to stop first

The issue names #272 open question 3 ("Does the Zonal Manager get Distribute, or only OH + CSM?") and
says explicitly: **answer before building, do not widen the ladder on your own judgement.** That is a
business-rule decision this session could not make alone (CLAUDE.md's Strategic HITL policy: stop for
business-rule conflict). Put to the operator directly; **ruled: all managers** — the same
`MANAGER_ROLES` ladder as the console's own draft/commit (#273/#275), not the narrower `dispatch-run`
ladder (OH + CSM) the issue text raised as the closer precedent. Recorded in #272's decision record
(Q3, now ruled) before any code was written.

## What was wrong

Every manual write in the codebase was N→1. Putting two engineers across three plants meant running a
panel twice with no cross-run memory and no diff — the operator ask "several plants, several engineers,
one pass" had no surface at all.

## The real design question: three strategies, one source of truth

The issue's hard constraint — "selection logic exists in exactly one place… any strategy implemented
client-side, or as a second copy of the selection rules, will drift from the engine" — does not, on its
own, say how three *different allocation policies* can share one selection. The answer that held up:

**Eligibility, tier and readiness are never re-derived.** `CandidateQueryService`'s
`buildCandidateReadiness` + `applyHardFilters` — already the exact function the recommender itself
calls (#274) — answers "who can cover this plant, at what tier, and are they passing right now" for
every strategy alike. That question has exactly one answer regardless of who asks it or why.

**The three strategies are the allocation *policy* the issue explicitly commissions three answers to
— not a second copy of the eligibility rule.** `COVERAGE_TIER` doesn't even build its own allocation:
it calls `RecommenderService.runForZone`'s scoped dry run (#250's seam, extended here with
`ticketIds`/`engineerIds`) and reports exactly what the engine would choose — which is what makes the
single-ticket/single-candidate AC true **by construction**, not by a separately-written comparison.
`CAPACITY_HEADROOM` and `PLANT_WHOLE` are pure allocation over the one shared readiness read: same
tier-order rule, different tie-break within the best available tier (most headroom, per ticket, vs. a
single whole-plant winner).

## Extending #250's seam without re-deriving the engine

`RecommenderService.runForZone` gained two opts: `ticketIds` (an extra `WHERE ticket_id IN (...)`
clause on the same ticket read, subject to every other gate unchanged) and `engineerIds` (a filter on
`orderedCandidatesForPlant`'s result, applied once, at the one point it is called — everything
downstream, hard filters through scoring through capacity, runs over the narrowed pool exactly as it
always has). Both are `undefined` by default, so every existing caller — the real dispatch, #250's own
zone-wide preview — is provably unaffected; `test/recommender-scoped-projection.e2e-spec.ts` pins the
scoping behaviour directly against the engine, separately from Distribute's own service.

## Why `CAPACITY_HEADROOM` and `PLANT_WHOLE` are per-*plant*, not per-ticket, for eligibility

Coverage (`se_coverage` / the floating MV) is a (engineer, plant) fact, not a (engineer, ticket) one —
every ticket at one plant sees the identical eligible pool and tier ordering. So "respecting tier
order" only has one place it can be decided: once per plant, before any ticket-level placement choice.
`PLANT_WHOLE` stops there (one winner, whole plant). `CAPACITY_HEADROOM` descends to per-ticket
placement **within** that already-decided tier, sorting candidates by remaining headroom
(`dailyCapacity − (committed + placed-so-far-in-this-projection)`) so a tied best tier actually spreads
load instead of piling onto whichever candidate a stable sort happens to favour — verified with a
fixture built specifically to force the tie (`distribute-preview.e2e-spec.ts`'s `plantTie` fixture:
two same-tier engineers, both capped at 1, both starting empty) rather than trusted from the shape of
the code.

## Verification

- Backend: full suite, 4 foreground chunks — **417 files / 2109 tests (5 pre-existing env-gated
  skips), 0 failed** (one `#184` Windows worker-crash flake, self-recovered on retry — documented,
  unrelated). New: `test/recommender-scoped-projection.e2e-spec.ts` (5 tests — the `runForZone` scope
  itself, isolated from Distribute's own allocation logic) and `test/distribute-preview.e2e-spec.ts`
  (8 tests — no-mutation, determinism, single-ticket/single-candidate agreement across all three
  strategies, strict-tier + capacity-drop parity with the engine, plant-whole never splitting, headroom
  spreading a tie, request validation). Extended `schedules-route-conflicts.e2e-spec.ts` for the new
  route's wiring/validation.
- Admin: full suite — **106 files / 562 tests, 0 failed** (the same pre-existing unrelated
  `TicketDetailDrawer.tsx:440` runtime fault every recent handoff reports). New Distribute suite in
  `assign-console.test.tsx` (3 tests: projection → editable draft → ledger recompute, the partial-plant
  chip indicator, the no-eligible-engineer rail); `assign-console-candidates.test.tsx` unaffected.
- `tsc --noEmit` clean on both `apps/backend` and `apps/admin`.
- No schema change, no new migration.

## What's next

P9 is 5 of 6 done (#272–#276). Remaining: **#277** `absorb-orphaned-assignment-surfaces` (orphaned
`CriticalQueue` → Critical+ preset, `available-ses`' bare-UUID row shape, the never-built intra-day
manual-assign modal, `PlannerPage` names) — the last P9 issue, closing the console out.
