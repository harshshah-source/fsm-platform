# FE-15 — Component queues (one recipe)

Status: ready-for-agent
Type: AFK · Frontend · Phase F4
Effort: M

> Governed by `DESIGN-SYSTEM.md` §8 (one queue recipe). Global DoD applies.

## What to build

Apply the shared `MetricStrip + FilterBar + DataTable + StatusPill` recipe to the component queues to match
`18`/`19`: `ComponentRequestsPage` (+ `readOnly` oversight variant) and `ShadowUseQueuePage`.
(Component-Blocked already reskinned in FE-03.) Approve/ship/reconcile actions via `Modal` + `Toast`;
logic unchanged.

## Dependencies

- FE-03, FE-04

## Acceptance criteria

- [ ] `ComponentRequestsPage` (WM) + `readOnly` oversight match `18`
- [ ] `ShadowUseQueuePage` matches `19`
- [ ] Approve/ship/reconcile via `Modal` + `Toast`; existing APIs + selectors preserved

## Reusable components introduced

- (consumes FE-03/04; establishes the canonical queue recipe)

## Affected pages

- `ComponentRequestsPage` (+`readOnly`), `ShadowUseQueuePage` (**[RP]**)

## Reference

- `18`, `19`

## Verification

- `component-requests.test.tsx`, `component-requests-oversight.test.tsx`, `component-waiting-badge.test.tsx`, `shadow-use-queue.test.tsx` green; Playwright ≈ `18`/`19`
