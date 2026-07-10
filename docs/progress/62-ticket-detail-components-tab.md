# Progress — Issue 62: Ticket Detail Components tab

> Build date: 2026-06-25 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE** — the Ticket Detail drawer **Components** tab now renders the ticket's Component
> Request(s) + the WAITING_COMPONENT / SLA-paused badge. No deferred surfaces (mobile n/a). Backend
> **+1 service method / +1 GET route / +1 e2e file**; admin **+1 api fn / drawer tab fill / +1 test**.
> Backend `tsc` clean; admin **76/76** + `tsc` clean. No migration.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Components tab lists the ticket's Component Request(s) with status + requested component | 🟢 | `apiComponentRequestsByTicket` → `GET /api/component-requests/by-ticket/:ticketId` → `ComponentRequestService.byTicket` (all statuses, newest-first, zone-scoped). Tab renders component name + status chip per request. `ticket-components-tab.test` (2). |
| 2 | Shows delivery destination + tracking ref when SHIPPED; rejection reason when REJECTED | 🟢 | Per-row conditional: SHIPPED → "Shipped to {destination} · tracking {ref}"; REJECTED → "Rejected: {reason}". |
| 3 | WAITING_COMPONENT / SLA-paused badge derived from the Failure Cycle state | 🟢 | `data-testid="waiting-component-badge"` shown when `ticket.failureCycleState === 'WAITING_COMPONENT'` (with `waitingComponentSince` timestamp — both already on `/api/tickets/:id`, Issue 23). |
| 4 | Read-only; deep-link from the Component-Blocked / Component Requests queue lands here | 🟢 | No mutation actions in the tab. The `/tickets/:id?tab=Components` deep-link (Issue 21/22, e.g. `ComponentRequestsPage` ticket link) now lands on a real tab instead of the stub. |

## Slice-by-slice RED→GREEN report

- **Slice 1 — backend per-ticket read.** `ComponentRequestService.byTicket(ticketId, scope, now)` reuses
  `buildRows` with `{ ticketId, ...zoneScope }` (ZM own-zone via the ticket's plant→zone; CSM /
  Operations Head all zones), returning ALL statuses newest-first (distinct from the WM active-only
  queue and the zone-wide oversight list). `GET /api/component-requests/by-ticket/:ticketId`
  (manager-roled; static prefix clears the `:id` POST action routes). RED = missing method.
  `component-request-by-ticket.e2e-spec` (3) GREEN.
- **Slice 2 — admin Components tab.** Replaced the Components stub in `TicketDetailDrawer` with a
  lazy-loaded list (fetch on tab open) of request cards (component / status chip / shipped destination+
  tracking / rejection reason / age) + the WAITING_COMPONENT/SLA-paused badge. `apiComponentRequestsByTicket`
  api fn. RED = stub still rendered. `ticket-components-tab.test` (2) GREEN; the Issue-07 drawer
  regression (`ticket-detail-drawer.test`) stays green (Forms/Verification/Assignment History remain
  stubs).

## Deviations / decisions

1. **Reused the existing component-request data, no new shape.** `byTicket` returns the same
   `ComponentRequestRow` the WM/oversight surfaces use; the admin reuses the `ComponentRequestRow` type
   and `CR_STATUS_CLASS` colours for consistency with the Component Requests queue page.
2. **WAITING_COMPONENT badge reads the ticket, not the request.** The pause signal is the Failure
   Cycle state already projected onto `/api/tickets/:id` (`failureCycleState`, `waitingComponentSince`,
   Issue 23) — no extra call, single source of truth.
3. **Lazy fetch on tab open.** The byTicket call fires only when the Components tab is selected (or
   deep-linked via `?tab=Components`), keeping the default Overview open cheap.

## Parity-gate disposition

- **Admin surface built** in-issue: Ticket Detail Components tab (fills the Issue 07 stub;
  v2-reference/08-ticket-detail + 28-tickets-drawer). **Mobile: n/a.** No deferred surfaces — Issue 62
  is fully closed, not accepted-with-follow-up.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run test/component-request-by-ticket.e2e-spec.ts
cd apps/admin && node node_modules/vitest/vitest.mjs run test/ticket-components-tab.test.tsx test/ticket-detail-drawer.test.tsx
```
