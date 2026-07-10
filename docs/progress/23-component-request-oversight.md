# Progress — Issue 23: Component Request oversight (ZM read-only + 7-day escalation)

> Build date: 2026-06-24 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **ACCEPTED** (backend + admin oversight/badge complete). Backend **+4 test files / 0 migration**
> (read-only, no schema change); admin **+2 tests / +1 page mode**; `tsc --noEmit` clean both apps.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | ZM sees own-zone Component Requests read-only | 🟢 | `ComponentRequestService.oversightQueue` zone-scopes ZM via ticket.plant.zone; `GET /api/component-requests` (managers). `component-request-oversight` (2). |
| 2 | CSM / Operations Head see all-zones read-only | 🟢 | Same; non-ZM roles are unrestricted. `component-request-oversight` (2). |
| 3 | WAITING_COMPONENT > 7 days surfaces in ZM Action Required and notifies ZM | 🟢 | `DashboardService.actionRequired(scope,now)` flips `waiting_component_overdue` with a real zone-scoped count (paused > 7d). `waiting-component-escalation` (3). **ZM notify = Issue 03 delivery seam.** |
| 4 | Ticket List flags WAITING_COMPONENT with days elapsed + Component Request status | 🟢 | ticket-query adds `waitingComponentSince` + `componentRequestStatus`; admin `InlineBadges` shows "WAITING COMPONENT · Nd · STATUS" (darkens past 7d). `ticket-waiting-component` (1) + `component-waiting-badge` (2). |
| 5 | No stock-movement actions exposed to ZM unless explicitly authorized | 🟢 | Oversight endpoint + page are read-only (no approve/ship/reject); WM mutation routes stay WAREHOUSE_MANAGER-only. `component-requests-oversight` admin test (1). |

## Slice-by-slice RED→GREEN report

- **Slice 1 — manager oversight read.** `oversightQueue(scope)` (refactored shared `buildRows` out of
  `queue()`); zone-scoped for ZM, all-zones for CSM/OH; read-only `GET /api/component-requests`
  (MANAGER_ROLES). `component-request-oversight` (2).
- **Slice 2 — 7-day escalation.** `actionRequired` → async + scope-aware; `waiting_component_overdue`
  card flipped available with a zone-scoped `COUNT` of WAITING_COMPONENT cycles paused > 7 days;
  controller awaits + passes scope; Issue-06 stub test updated for the now-live card.
  `waiting-component-escalation` (3).
- **Slice 3 — ticket-list flag (backend).** `waitingComponentSince` (gated to WAITING_COMPONENT) +
  latest `componentRequestStatus` subquery added to the ticket list/detail SELECT + view.
  `ticket-waiting-component` (1).
- **Slice 4 — admin UI.** (a) `InlineBadges` WAITING_COMPONENT badge enriched with days-elapsed +
  CR status (`component-waiting-badge`, 2). (b) `ComponentRequestsPage` gains a `readOnly` mode reading
  `/component-requests` with no WM actions; route `/component-requests` (managers) + manager nav link
  (`component-requests-oversight`, 1).

## Deviations / decisions (read before extending)

1. **No schema change.** Oversight, escalation, and the ticket-list flag are all reads over the Issue 22
   `component_request` table + existing `failure_cycles` pause fields. No migration.
2. **Escalation is computed on read, not a worker.** The "ComponentSla worker" is realised as a
   zone-scoped query in `DashboardService.actionRequired` (same posture as Issue 06's inline
   aggregations; BullMQ/MV deferred). Crossing the 7-day threshold lights the Action Required card;
   the **ZM notification** itself is the notification spine (Issue 03, HITL) — the external seam.
3. **Days-elapsed is client-derived.** The backend returns `waitingComponentSince` (the pause
   timestamp), not a precomputed day count, so the value stays deterministic and the badge/age update
   live without a server round-trip.
4. **One page, two modes.** The WM queue and the manager oversight view share `ComponentRequestsPage`
   (`readOnly` prop) — same layout (v2-reference/18), actions hidden for managers. WM route
   `/warehouse/requests` (actions); manager route `/component-requests` (read-only).

## Parity-gate disposition (CLAUDE.md / workflow.md)

- **Admin surfaces built in-issue:** manager read-only oversight page + Ticket List WAITING_COMPONENT
  badge; the Action Required `waiting_component_overdue` card now renders live via the existing panel.
- **Mobile:** n/a (manager oversight is desktop; the SE component loop screens are Issues 58/60).
- **Notification:** ZM-notify on threshold-crossing → Issue 03 (HITL) delivery seam.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run \
  test/component-request-oversight.e2e-spec.ts test/waiting-component-escalation.e2e-spec.ts \
  test/ticket-waiting-component.e2e-spec.ts test/dashboard-action-required.e2e-spec.ts
cd apps/admin && node node_modules/vitest/vitest.mjs run \
  test/component-waiting-badge.test.tsx test/component-requests-oversight.test.tsx
```
