# 55 — M1: SE Home (Day Plan, kit badge, Ticket Pool, last-sync)

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The SE Home tab. Surfaces already-built backend: online/last-sync pill (Issue 04 snapshot data-as-of),
Day Plan / Next Visit / Plant Workload (Issue 11 `/api/schedules/me`), Common-Kit badge
(Issue 21 `/api/me/van-stock`), and an **Open Ticket Pool** entry (Issue 12 `/api/me/shared-pool`).

## Business rules (authority)

- PRD §503 Flow 1 (Work Schedule / Day Plan View) + §617 Flow 12 (Van Stock — kit badge). Pre-dispatch
  copy: *"Your plan is being prepared — check back shortly."* (PRD §508).

## Acceptance criteria

- [ ] Online / last-sync pill reflects snapshot data-as-of
- [ ] Day Plan / Next Visit / Plant Workload rendered from `/api/schedules/me`
- [ ] Common-Kit status badge rendered from `/api/me/van-stock` (closes Issue 21 AC#5 UI; supersedes 52)
- [ ] Open Ticket Pool entry navigates to the pool (M2)
- [ ] Pre-dispatch (`dispatched=false`) shows the "plan is being prepared" empty state

## API contract (authority: backend on `main`)

- `GET /api/schedules/me` → `DayPlanView { dispatched, scheduleId, dateFrom, dateTo, stops:[{ batchId,
  stopSequence, plantId, plantName, deviceCount, tickets:[{ ticketId, sortOrder }] }] }`
  (`scheduling/day-plan-query.service.ts`). Empty-state when no ACTIVE schedule: `dispatched=false, stops=[]`.
- `GET /api/me/van-stock` → `{ stock: VanStockItem[], commonKit: CommonKitStatus }` (`inventory.controller.ts`,
  `@Controller('me')`). Kit-complete when no van-stock rows (Issue 21 rule).
- `GET /api/me/shared-pool` → `SharedPoolTicket[]` (`shared-pool.controller.ts`) — count for the pool entry.
- Last-sync source: the snapshot data-as-of carried by the snapshot/freshness read (Issue 04).

## Permissions

- All three endpoints are SE-only and server-scoped to the caller's own id (no se param).

## Navigation

- Open Ticket Pool entry → Tickets tab pool list (Issue 56 / M2).

## Offline behaviour

- Reads render from cache when offline; last-sync pill shows the cached data-as-of with an offline indicator.

## Edge cases & failures

- `dispatched=false` → empty state, no Day Plan list.
- `commonKit` incomplete → red "Kit Incomplete: [items]" badge; complete → green "Kit Complete" (PRD §619).
- Empty shared pool → no pool count / disabled entry.

## UI surfaces

- **Mobile:** Home tab. Owned by this issue.
- **Admin:** n/a.

## Reference

- `docs/ui/mobile/home-dashboard.png.png`

## Tests (TDD targets — red first)

- `dispatched=true` renders stops grouped by plant in `sortOrder`; `dispatched=false` renders the prepare state.
- Kit-incomplete `commonKit` renders the red badge with the missing-item list; complete renders green.
- Pool entry navigates to M2.
- Offline read renders cached plan + offline last-sync indicator.

## Blocked by

- #54, #04, #11, #21, #12
