# 62 — Ticket Detail Components tab: request status + WAITING_COMPONENT pause

Status: ready-for-agent
Type: AFK

## What to build

Fill the Ticket Detail drawer **Components** tab (currently a stub) so it surfaces the component loop on
a ticket: the active/most-recent Component Request and its status (REQUESTED → APPROVED | REJECTED →
SHIPPED → RECEIVED), the requested component, delivery destination + tracking when shipped, rejection
reason when rejected, and a **WAITING_COMPONENT / SLA-paused** badge derived from the Failure Cycle.
Part of the drawer-retrofit lineage (UI Ownership Plan A1). Read-only for the ZM; the deep-link target
`/tickets/:id?tab=Components` already exists (Issue 21 / Component-Blocked Queue rows link here).

## Acceptance criteria

- [ ] Components tab lists the ticket's Component Request(s) with status + requested component
- [ ] Shows delivery destination + tracking ref when SHIPPED; rejection reason when REJECTED
- [ ] Shows a WAITING_COMPONENT / SLA-paused badge derived from the Failure Cycle state
- [ ] Read-only; deep-link from the Component-Blocked Queue and Component Requests queue lands here

## UI surfaces

- **Admin:** Ticket Detail drawer Components tab (fill the stub). Owned by this issue.
- **Mobile:** n/a.

## Reference

- `docs/ui/desktop/v2-reference/08-ticket-detail.png`
- `docs/ui/desktop/v2-reference/28-tickets-drawer.png`

## Blocked by

- #22
