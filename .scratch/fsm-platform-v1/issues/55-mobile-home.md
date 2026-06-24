# 55 — M1: SE Home (Day Plan, kit badge, Ticket Pool, last-sync)

Status: ready-for-agent
Type: AFK

## What to build

The SE Home tab. Surfaces already-built backend: online/last-sync pill (Issue 04 snapshot data-as-of),
Day Plan / Next Visit / Plant Workload (Issue 11 `/api/schedules/me`), Common-Kit badge
(Issue 21 `/api/me/van-stock`), and an **Open Ticket Pool** entry (Issue 12 `/api/me/shared-pool`).

## Acceptance criteria

- [ ] Online / last-sync pill reflects snapshot data-as-of
- [ ] Day Plan / Next Visit / Plant Workload rendered from `/api/schedules/me`
- [ ] Common-Kit status badge rendered from `/api/me/van-stock` (closes Issue 21 AC#5 UI; supersedes 52)
- [ ] Open Ticket Pool entry navigates to the pool (M2)

## UI surfaces

- **Mobile:** Home tab. Owned by this issue.
- **Admin:** n/a.

## Reference

- `docs/ui/mobile/home-dashboard.png.png`

## Blocked by

- #54, #04, #11, #21, #12
