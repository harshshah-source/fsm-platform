# 342 — Audit ledger search + admin viewer + drawer Audit tab
Status: ready-for-agent
Type: AFK
Wave: 1 · Severity: P1 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

The only audit read is `GET audit-trail/tickets/:ticketId` (`audit/audit-trail.controller.ts:15-27`,
no `@Query`, `entityType:'ticket'` hard-filtered at `audit-trail.service.ts:50`). No admin screen
calls it; the drawer's history derives from `ticket.lifecycle`. Only OH, behind
`OPS_EXPLORER_ENABLED`, can see any audit row. Every audit row written by 343 and 340 is unreadable
until this lands.

## Current code

- `audit/audit-trail.controller.ts:15-27` — single route `GET audit-trail/tickets/:ticketId`, no
  `@Query`
- `audit-trail.service.ts:50` — `entityType:'ticket'` hard-filtered
- `schema.prisma:1733` — `audit_logs`; index coverage on `(actor_id, created_at)` /
  `(entity_type, entity_id)` to be checked
- Admin: no `api/auditTrail.ts`; no audit page; `pages/tickets/TicketDetailDrawer.tsx` history
  derives from `ticket.lifecycle`
- Ops Explorer `auditLogs` dataset already projects `a.metadata::text`
  (`ops-explorer/dataset-registry.ts:2628-2640`, since `ba6053c`) — OH-only, behind
  `OPS_EXPLORER_ENABLED`

## What to build

- `audit-trail.controller.ts` — add `GET /audit-trail` with query params `actorUserId`,
  `actedAsRole`, `zoneId`, `action`, `entityType`, `entityId`, `from`, `to`, `cursor`, `limit`
- `audit-trail.service.ts` — `search()`; ZM clamped to own zone via `@CurrentScope`
- `schema.prisma:1733` — index check on `audit_logs(actor_id, created_at)` /
  `(entity_type, entity_id)`
- Admin: new `api/auditTrail.ts`; new `pages/admin/AuditTrailPage.tsx` (OH/CSM all zones, ZM own
  zone); `AppRoutes.tsx`; `lib/nav.ts`
- Admin: `pages/tickets/TicketDetailDrawer.tsx` — Audit tab rendering `kind:'ACTION'` rows with
  actor, acting role, reason, from/to metadata
- Tests: `test/audit-trail-controller.e2e-spec.ts`; admin page + drawer tests
- Expected behaviour: any manager can answer "who did what, in whose scope, when" without knowing
  a ticket UUID

## Acceptance criteria

- [ ] AC1 — filters are honoured (byte-identical bodies for different filters is a failing test)
- [ ] AC2 — ZM sees own zone only
- [ ] AC3 — `metadata` rendered as from/to where present
- [ ] AC4 — drawer Audit tab shows the action chain for the ticket, including acting role
- [ ] AC5 — keyset pagination, `limit ≤ 200`

## Verification

e2e per filter + clamp; admin tests.

## UI surfaces

- Admin: Audit Trail page (new; OH/CSM all zones, ZM own zone)
- Admin: Ticket detail drawer — Audit tab (modified)
- Admin: navigation (modified — new entry)

## Reference

- `docs/ui/desktop/v2-reference/28-tickets-drawer.png` for the drawer tab
- No v2 image exists for a ledger page — follow the Ops Explorer table chrome and record the page
  as an approved-design gap in `docs/ui/desktop/approved-designs/README.md`

## Blocked by

— (none)

## Absorbs / supersedes

- survey ids: NOTIF-03, NOTIF-04, AC-05
- existing issues: #145 (closes into this slice when it lands)

## Downstream

The rows written by 343 and 340 become readable here (plan §5).
