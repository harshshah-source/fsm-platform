# 298 — Manual assignment closes the escalation row it resolves
Status: **done** (2026-09-02) — report [`docs/progress/298-manual-assign-closes-escalation-row.md`](../../../docs/progress/298-manual-assign-closes-escalation-row.md). The regression check on the efficiency cube came back **negative** (it reads current status, not creation) — pre-existing, not caused by this slice, filed as [#333](./333-auto-escalations-cube-counts-current-status.md).
Type: AFK
Wave: 1 · Severity: P1 · Finding: CB-2, `audit/2026-09-01-scheduler-engine-forensics.md` §6

## Problem

The Scheduler Console's red interception strip says "N critical tickets need manual assignment"
and offers "Assign this work →". An operator who does exactly that — assigns the escalated ticket
through the Inspector's Assign door — sees the row come back on refetch, still counted in
`criticalNeedsYou`, now reading "Reassign this work →". The escalation persists indefinitely.
Cross-layer defect: every component individually looks correct.

## Root cause

The strip's Assign path resolves to `POST /schedules/assign` → `OverrideService.assignTicket`
(`scheduling/override.service.ts:493-674`), which never touches `intraday_insertions`. Only two
paths close an `ESCALATION_REQUIRED` row: `moveTickets` (`override.service.ts:1149-1152`, stamps
`ACCEPTED` in-tx) and the intraday queue's own `manual-assign`
(`intraday/intraday-insertion.service.ts:404, 439`). And the read
(`dispatch-today-query.service.ts:860-882` `escalationsOpen`) filters **only** on
`status: 'ESCALATION_REQUIRED'`, not on the ticket still being unassigned.

## Affected files / symbols

- `apps/backend/src/scheduling/override.service.ts` — `assignTicket` transaction (:589-659)
- Read-only reference: `override.service.ts:1149-1152` (the pattern to mirror),
  `dispatch-today-query.service.ts:860-882`, `TodaysDispatchPage.tsx:585-667` (strip verbs)

## Intended behavior after fix

`assignTicket` stamps any open `ESCALATION_REQUIRED` row for the ticket it assigns to `ACCEPTED`
(with `offeredSeId` = the assignee, `respondedAt`) **inside the same audited transaction** — the
exact treatment `moveTickets` already gives (its rationale applies verbatim: "an escalation
nothing can clear would leave the queue asking for a decision already taken"). The strip and
`criticalNeedsYou` then clear on the post-write refetch with no frontend change.

## Implementation boundaries

- Primary fix is the write (mirror `:1149-1152` into `assignTicket`'s tx). Do **not** also change
  `escalationsOpen`'s filter in this slice unless the write fix alone cannot satisfy AC1 — a
  read-side filter change alters what the Intraday Queue shows and belongs to its own decision.
- `assignLane` (assign-batch) inherits the same stamp only if it does not already route through
  the same code — verify, don't assume; if it needs its own stamp, add it with the same guard.
- Do not touch the #268 re-escalation guard or `insertion_type` semantics.

## DB / API / frontend impact

- DB: writes `intraday_insertions.status/offered_se_id/responded_at` on existing rows (no schema
  change). API: `POST /schedules/assign` and `/assign-batch` gain a side effect already documented
  for moves. Frontend: none — the existing refetch renders the cleared strip.

## Dependencies

None. Independent. (Touches `override.service.ts`, so land before or after #306/#307/#310 in
sequence, not concurrently.)

## Regression risks

- Stamping must be `updateMany` guarded on `status: 'ESCALATION_REQUIRED'` so a concurrent
  manual-assign from the Intraday Queue does not double-respond.
- The efficiency cube counts `ESCALATION_REQUIRED` (`auto_escalations`); closing rows as ACCEPTED
  must not alter historical counts — confirm the cube reads creation, not current status.

## Tests required

- e2e: escalated ticket → `POST /schedules/assign` → the insertion row is ACCEPTED with the
  assignee; `GET /dispatch/today` no longer lists it in `escalations` and `criticalNeedsYou`
  drops (the round trip the current suites stop short of).
- e2e: assign-batch path, same assertion.
- Race: barrier-harness test — console assign vs intraday manual-assign on the same row; exactly
  one responder recorded.
- Frontend (admin): strip → Assign → refetch renders zero escalations for that ticket (mock API).

## Acceptance criteria

- [x] AC1 — assigning an escalated ticket through ANY manual door leaves no open
      `ESCALATION_REQUIRED` row for it.
- [x] AC2 — the stamp is transactional with the assignment (a rolled-back assign closes nothing).
- [x] AC3 — a removal still deliberately does NOT close the escalation (per #288's recorded rule).

## UI surfaces

Admin: Scheduler Console interception strip (existing — behavior only, no layout change).

## Reference

n/a (no layout change).

## Blocked by

— (independent)
