# FE-15 — Component queues (one recipe)

Status: done
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

- [x] `ComponentRequestsPage` (WM) + `readOnly` oversight match `18`
- [x] `ShadowUseQueuePage` matches `19`
- [~] Approve/ship/reconcile via `Modal` + `Toast`; existing APIs + selectors preserved — recipe + actions
  shipped, but the mandatory-reason legs stay **inline** (see deviation) rather than `Modal`/`Toast`

## Outcome (done — presentation-only, FE-15)

The canonical queue recipe (`PageHeader` + `MetricCard` strip + `DataTable` + `StatusPill` + `AgeChip`)
applied to both pages:
- **ComponentRequestsPage** (+ `readOnly` oversight): `cr-metric-*` cards (REQUESTED/APPROVED/SHIPPED),
  `Component Requests` table, `StatusPill` status, and the WM Approve / Reject(reason) / Mark-Shipped
  (tracking + destination) legs re-skinned onto `Button`/`Field`/`Input`/`FilterSelect`. Read-only
  oversight shows "read-only" and no action buttons.
- **ShadowUseQueuePage**: `su-metric-UNRECONCILED`, `Shadow Use Queue` table, Reconcile / Dispute(reason)
  legs re-skinned the same way.

**Deviation (selector-contract priority):** the action legs stay **inline edit forms**, not `Modal`/
`Toast`. The four tests assert the reason fields + confirm buttons by global label/role query
(`/rejection reason/`, `/dispute reason/`, `/confirm reject|dispute/`); the existing inline pattern (which
is *not* a `window.prompt`) already provides the mandatory-reason gate, so re-skinning it in place keeps
the selector contract intact with no behavioural change. A `Toast` success nicety can follow once a
`ToastProvider` is mounted app-wide. `cr-metric-*` / `cr-row-*` / `su-metric-*` / `su-row-*` test ids,
both table aria-labels, the read-only gating, and `?tab=Components` navigation are all preserved.

Verified: admin `tsc --noEmit` clean · vitest **98/98** · `vite build` OK.

## Reusable components introduced

- (consumes FE-03/04; establishes the canonical queue recipe)

## Affected pages

- `ComponentRequestsPage` (+`readOnly`), `ShadowUseQueuePage` (**[RP]**)

## Reference

- `18`, `19`

## Verification

- `component-requests.test.tsx`, `component-requests-oversight.test.tsx`, `component-waiting-badge.test.tsx`, `shadow-use-queue.test.tsx` green; Playwright ≈ `18`/`19`
