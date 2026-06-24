# 23 — Component Request oversight (ZM read-only + 7-day escalation)

Status: ready-for-agent
Type: AFK

## What to build

Manager visibility and SLA escalation over component requests. The Component Requests read-only view (`/warehouse/requests` ZM/CSM/OH variant): own-zone (ZM) / all-zones (CSM, OH) read-only rows showing component, ticket/device, the SE who raised it, request status, Warehouse action/status, and age — no ability to approve stock movement unless explicitly authorized. The `ComponentSla` worker drives the 7-day auto-escalation: a WAITING_COMPONENT Ticket exceeding 7 days surfaces in the ZM Action Required panel, and the Ticket List flags WAITING_COMPONENT tickets (amber + days elapsed) with the Component Request status. ZM notified when the threshold is crossed.

## Acceptance criteria

- [ ] ZM sees own-zone Component Requests read-only (component, ticket/device, SE, status, WM action, age)
- [ ] CSM / Operations Head see all-zones read-only
- [ ] WAITING_COMPONENT >7 days surfaces in ZM Action Required and notifies the ZM
- [ ] Ticket List flags WAITING_COMPONENT with days elapsed + Component Request status
- [ ] No stock-movement actions exposed to ZM unless explicitly authorized

## Blocked by

- #22
