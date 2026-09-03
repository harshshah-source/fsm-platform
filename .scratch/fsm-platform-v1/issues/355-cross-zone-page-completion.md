# 355 — Cross-zone page completion: flag from ticket, re-escalate, modal, deferred resurfacing, history
Status: done 2026-09-03 — report docs/progress/355-cross-zone-page-completion.md
Type: AFK
Wave: 3 · Severity: P2 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

The cross-zone workflow has its backend but half its doors are missing. `apiCrossZoneFlag` has zero
call sites (**#92**), so a ZM cannot flag a ticket cross-zone from anywhere. A DENIED AUTO row
vanishes from `listForScope` (`cross-zone-escalation.service.ts:225`) and the ZM re-escalate route
(`cross-zone.controller.ts:103`) has no button (**#93**). Approve uses five `window.prompt`s
(`CrossZonePage.tsx:56-72`) and the target zone is not validated against the chosen SE
(`service:170-171`). Deferred escalations persist a `reviewDate` (`:271`) and nothing ever resurfaces
them. There is no read of who approved what — `listForScope` excludes APPROVED and DENIED.

## Current code

- `apiCrossZoneFlag` — zero call sites.
- `cross-zone-escalation.service.ts:225` — DENIED AUTO rows drop out of `listForScope`; `:170-171` —
  target zone not validated against the SE; `:271` — `reviewDate` persisted, never acted on.
- `cross-zone.controller.ts:103` — ZM re-escalate route with no UI.
- `CrossZonePage.tsx:56-72` — approve via five `window.prompt`s.
- `listForScope` — excludes APPROVED / DENIED, so no decision history is readable.

## What to build

- `pages/tickets/TicketDetailDrawer.tsx` — ZM "Flag cross-zone" action with a reason modal, hidden
  for PLATINUM tickets.
- `cross-zone-escalation.service.ts` — `listForScope` includes DENIED AUTO rows for the home ZM;
  `history(scope, range)`; a due-review sweep in `business-sweep-scheduler.service.ts` `crossZoneTick`
  moves DEFERRED rows past their `reviewDate` back to PENDING with a notice.
- `cross-zone.controller.ts` — `GET /cross-zone/history`.
- `cross-zone.dtos.ts` — derive / validate `targetZoneId` from the SE's `engineerMaster.zoneId`.
- `CrossZonePage.tsx` — approve Modal with zone select + SE picker from `api/engineers.ts`;
  Re-escalate button for ZM; Review-date column; History tab.
- `api/crossZone.ts` — clients for the above.
- Tests: e2e + admin.

## Acceptance criteria

- [x] AC1 — a ZM can flag a Gold/Silver ticket cross-zone from its drawer.
- [x] AC2 — the home ZM sees DENIED AUTO rows and can re-escalate.
- [x] AC3 — approve uses a modal; the SE picker constrains the zone; a mismatch → 400.
- [x] AC4 — a deferred row returns to PENDING on its review date, with a notice.
- [x] AC5 — history lists decisions with decider, acting role, reason, date; zone-clamped for ZM.

Also landed here: **#335** (the `TicketDetailDrawer` Assignment-History crash on an attempts payload
with no `attempts` array) — this slice owns the file, and the guard plus its regression test are in
`apps/admin/test/ticket-drawer-cross-zone-flag.test.tsx`.

Two premise corrections, detailed in the report: the service is `cross-zone-escalation.service.ts`
(there is no `cross-zone.service.ts`), and the plan's "derive/validate `targetZoneId` in
`cross-zone.dtos.ts`" is not implementable in a DTO — the engineer's zone is a database read, so the
agreement check lives in `approve`.

## Verification

e2e + admin tests (the plan's Verification is "tests e2e + admin").

## UI surfaces

Admin: Ticket detail drawer (modified — "Flag cross-zone") · Cross-Zone page (modified — approve
modal, Re-escalate, Review-date column, History tab).

## Reference

- `docs/ui/desktop/v2-reference/28-tickets-drawer.png` (the drawer action)
- The Cross-Zone page as built under #78 is the authority for its own layout.

## Blocked by

- #354 — atomic approve, `direction` flag and the target-ZM notice this page builds on

## Absorbs / supersedes

- survey ids: CZ-04, CZ-05, CZ-06, CZ-07, CZ-08
- existing issues: #92, #93 (each closes into this slice when it lands); the cross-zone legs of #80
  (close into this slice when it lands)
