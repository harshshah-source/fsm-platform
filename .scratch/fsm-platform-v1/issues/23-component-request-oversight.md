# 23 — Component Request oversight (ZM read-only + 7-day escalation)

Status: accepted (backend + admin oversight/badge done; ZM notify → Issue 03 seam)
Type: AFK
Progress: docs/progress/23-component-request-oversight.md — AC#1–#5 done. Manager read-only `/component-requests`; `waiting_component_overdue` Action Required card live (zone-scoped >7d); Ticket List WAITING_COMPONENT badge (days + CR status). No schema change. ZM notify = Issue 03 seam. 2026-06-24.

## What to build

Manager visibility and SLA escalation over component requests. The Component Requests read-only view (`/warehouse/requests` ZM/CSM/OH variant): own-zone (ZM) / all-zones (CSM, OH) read-only rows showing component, ticket/device, the SE who raised it, request status, Warehouse action/status, and age — no ability to approve stock movement unless explicitly authorized. The `ComponentSla` worker drives the 7-day auto-escalation: a WAITING_COMPONENT Ticket exceeding 7 days surfaces in the ZM Action Required panel, and the Ticket List flags WAITING_COMPONENT tickets (amber + days elapsed) with the Component Request status. ZM notified when the threshold is crossed.

## Acceptance criteria

- [x] ZM sees own-zone Component Requests read-only (component, ticket/device, SE, status, WM action, age)
- [x] CSM / Operations Head see all-zones read-only
- [x] WAITING_COMPONENT >7 days surfaces in ZM Action Required (notify ZM → Issue 03 delivery seam)
- [x] Ticket List flags WAITING_COMPONENT with days elapsed + Component Request status
- [x] No stock-movement actions exposed to ZM unless explicitly authorized

## Blocked by

- #22
