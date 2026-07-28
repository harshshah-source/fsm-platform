# 165 — SE poll-endpoint bounding + delta signals (pagination, cursors, change detection)

Status: ready-for-agent
Type: AFK · Backend

Filed 2026-07-28 (`docs/status/backend-mobile-readiness-plan-2026-07-28.md` §A-§4, §B N8/N11).
The SE surface has **no paginated endpoint at all**, and a polling client has no way to detect
"nothing changed". Adding cursors/versions after a client exists is a breaking change — this is
cheap now and expensive later, which is why it gates the mobile data layer, not mobile start.

Measured 2026-07-28: shared pool worst **1,015 tickets (~152 KB) / avg 216 per SE per poll**
(36 covered SEs); one live schedule holds **1,453 tickets** and `/schedules/me` would serve it
whole; notifications are stuck at newest-50 with no paging.

## What to build

1. **Shared pool** (`shared-pool.service.ts:38-52`): `take` (default ~50) + cursor; keep the
   existing sort. The pool scales with backlog, not workload — unbounded by design is unacceptable
   at phone payloads.
2. **Notifications** (`notifications.controller.ts:17-19`, `notification.service.ts:90-94`): pass
   `limit` through; add cursor + `since` param for delta-sync.
3. **Day plan** (`day-plan-query.service.ts:49-60`): bound the ticket list (`take` + cursor past a
   sane cap) and add a **plan change signal** — `planVersion` (or `updatedAt`) that changes on
   #127 APPEND / override / defer, so a poller can cheap-check before refetching. Batch `run_id`
   attribution exists (migration `20260721120000`) but is not surfaced — surface it or a derived
   version. Support `ETag`/`If-None-Match` (304) on all three poll endpoints.
4. **Root-cause cap**: `POST /schedules/assign-plants` has no capacity bound — [INFERRED] the source
   of the 1,453-ticket schedule. Add a bound or an explicit confirm-override; a plan no phone (or
   SE) can execute should not be constructible silently.

Contract-first: shapes reviewed against #54's data-layer needs before implementation freezes.
Coordinate with #147 (date-filter/closure) — its fix changes which schedule is served; this issue
changes how much of it and how change is detected. Note the APPEND/`dispatchedAt` interaction
recorded in #147.

## Acceptance criteria

- [ ] No SE read can return an unbounded list; documented caps + cursors on shared-pool, notifications, day-plan tickets
- [ ] `GET /notifications?since=` returns only newer items; cursor pages backward
- [ ] Day-plan responses carry a version that provably changes on APPEND/override/defer (e2e)
- [ ] 304 path measured: an unchanged poll costs no body bytes and ≤1 cheap query
- [ ] `assign-plants` cannot silently create a plan beyond the cap
- [ ] Admin surfaces consuming the same services are swept and stay green

## UI surfaces

n/a (contract; admin call-site sweep only if signatures change).

## Reference

n/a.

## Blocked by

- None. Coordinate with #147 and #106; consumed by #54/#55/#56/#85.

## Comments

### 2026-07-28 — headline changed: envelopes, not just cursors (freeze plan F1.4)

The contract inventory found something that outranks pagination: **`GET /api/me/shared-pool` and
`GET /api/org/geo/*` return bare top-level JSON arrays with no envelope.** Pagination cannot be
added to a bare array without a breaking change — so under the freeze bar the envelope
(`{items, cursor}`) is the load-bearing fix and the cursor is the easy part. Same for any new list
from #163.

Also added:
- **`/api/org/geo/{states,regions,districts}`** are SE-reachable *by omission* (no `@Roles`;
  `role.guard.ts:25-27`) and **unbounded** — no `take` on any of the three
  (`org/geography.service.ts:26-54`). Either bound them or role-gate them (**#169** item 8).
- Measurements refreshed 2026-07-28: worst shared pool **1,021** tickets (was 1,015); the largest
  live schedule is **1,453 tickets in a single stop** (`schedule_id=96`, `ACTIVE`, dated
  **2026-07-21**) — and because `getDayPlan` filters on status only, that week-old plan is what that
  SE's Home renders *today*. #147 and this issue are two angles on one defect; sequence them together.
- `GET /api/notifications` needs `limit` passthrough (the controller never passes it,
  `notifications.controller.ts:17-19`), a cursor, a `since`, and a total. Note `unread` is a string
  compared to the literal `'true'` — `'1'`/`'TRUE'` silently mean "no filter". Fix under #174/#169.

### 2026-07-28 — #172 decision 3: one list endpoint, not two

The Tickets list is merged (assigned + pool in one urgency-grouped list), so the envelope work here
targets **`GET /api/me/tickets`** with an `assigned` flag and a `workState` discriminator, rather
than bounding `/schedules/me` and `/me/shared-pool` as separate shapes. One shape, one cursor, one
client cache. The underlying day-plan/pool distinction becomes an implementation detail.

This makes the envelope decision *more* load-bearing, not less: the merged list is the single
highest-traffic read on the SE surface, and it is the one that must not ship as a bare array.

Note `/api/me/work-history` (**#175**) and the dated rows for Daily Status follow the same envelope
conventions.
