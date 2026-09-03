# 360 — SE poll contract: paginated tickets, VU-deferred visibility, readable day-plan notices
Status: done 2026-09-03 — report docs/progress/360-se-poll-contract.md
Type: AFK
Wave: 3 · Severity: P2 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

Three defects in the backend contract the SE app polls (mobile screens are out of scope; the
endpoints are not).

- `GET /me/tickets` (`me-tickets/me-tickets-query.service.ts:72-96`) returns the whole shared pool
  unpaginated — 521 rows on the dev DB.
- Filing vehicle unavailability defers the ticket (`vehicle-unavailability.service.ts:186-195`),
  and `notDeferredOn` (`me-tickets-query.service.ts:81`) drops it from the SE's own list the
  moment they file it — the SE loses sight of the ticket they just reported on.
- The day-plan notice body is `` `Your Day Plan was updated (${action}).` ``
  (`scheduling/day-plan-notifier.ts:75`) — a raw audit action leaks with no ticket or plant.

## Current code

- `apps/backend/src/me-tickets/me-tickets.controller.ts:34-38` — no paging query.
- `apps/backend/src/me-tickets/me-tickets-query.service.ts:72-96` — unpaginated pool read;
  `:81` — `notDeferredOn` excludes VU-deferred tickets.
- `apps/backend/src/ticketing/vehicle-unavailability.service.ts:186-195` — VU filing defers the
  ticket.
- `apps/backend/src/scheduling/day-plan-notifier.ts:75` — raw `${action}` in the notice body.
- `apps/backend/src/scheduling/day-plan-notification-outbox.ts:54` — outbox payload carries no
  `ticketId` / `plantName`.
- `packages/shared` — `MeTicketsView`.

## What to build

- `me-tickets.controller.ts:34-38` + query service — `take` (default 50), cursor, `section`
  filter; `total` returned; `MeTicketsView` in `packages/shared` updated.
- `me-tickets-query.service.ts` — new branch: tickets carrying the SE's own OPEN VU report are
  returned with `workState: 'VEHICLE_UNAVAILABLE'` (with state and return date).
- `day-plan-notifier.ts` — action → sentence map (e.g. "Stop added: <plant> (<ticket ref>)").
- `day-plan-notification-outbox.ts:54` — payload gains `ticketId`, `plantName` (or resolve them
  at drain time); if the payload widens, update the 7 `queueDayPlanOverridden` callers.
- Tests: `me-tickets-controller`, `me-tickets-removal-metadata`, `day-plan-notifier-spine`,
  `day-plan-notification-outbox` e2e.

## Acceptance criteria
- [x] AC1 — `GET /me/tickets` is paged, cursor-stable, default 50, and returns `total`.
- [x] AC2 — an SE who filed vehicle unavailability still sees the ticket, with its state and
      return date.
- [x] AC3 — day-plan notices read "Stop added: <plant> (<ticket ref>)" and similar — no enum
      leaks.
- [x] AC4 — unpaginated callers (none in admin; mobile) keep working via the defaults.

## Verification

The four e2e specs named above: paging + `total`, the VU-visible branch, the notice wording, and
the default-path compatibility.

## UI surfaces

n/a (backend-only; mobile rendering is excluded by plan scope).

## Reference

n/a.

## Blocked by
— (none)

## Absorbs / supersedes
- survey ids: TKT-11, TKT-12, SCH-09.
- existing issues: #165 — the tickets leg (paging of `/me/tickets`) closes into this slice when
  it lands; the shared-pool and day-plan bounding legs stay on #165.
