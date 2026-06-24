# 25 — SE Management page + Activity Status + Set Availability

Status: accepted (backend + admin page done; mobile SE self-availability → M-series)
Type: AFK
Progress: docs/progress/25-se-management-availability.md — AC#1–#5 backend + admin `/engineers` page done. Migration `20260624160000_add_se_availability`. SE-self set-availability mobile action → M-series (blocked-by #54). 2026-06-24.

## What to build

The SE Management page (`/engineers`). SE list: name, coverage type, derived Activity Status badge (AVAILABLE / ON_SITE / BUSY / SHIFT_ENDING / OFFLINE — computed at render time, never stored), today's Ticket count, Common Kit completeness chip. Click an SE → detail panel: current Day Plan status, Van Stock per component (missing in red), availability rows. ZM action: **Set Availability** (ON_LEAVE / OFF_SHIFT / WEEKLY_OFF / SOFT_UNAVAILABLE + time window) writing to the single time-windowed `se_availability` table. Setting an SE unavailable excludes them from Recommender candidate scoring for that window. ZM and SE are the only setters; Operations Head has no role here.

## Acceptance criteria

- [x] SE list shows derived Activity Status (render-time), coverage type, today's ticket count, kit chip
- [x] SE detail panel shows Day Plan status, per-component Van Stock (missing in red), availability rows
- [x] Set Availability writes ON_LEAVE / OFF_SHIFT / WEEKLY_OFF / SOFT_UNAVAILABLE with a time window
- [x] Unavailable SEs excluded from Recommender candidate scoring for the window
- [x] ZM scoped to own zone; Operations Head has no setter role here

## UI surfaces

- **Admin:** SE Management page (`/engineers`, v2-reference/15-se-activity) — metric cards + SE table
  (derived Activity Status badge, coverage, active tickets, Common-Kit chip) + detail panel (Day Plan,
  Van Stock with shortages in red, availability windows) + ZM/CSM Set-Availability action. Built here.
- **Mobile:** SE self set-availability — **blocked-by Mobile Foundation #54**, deferred to the M-series.

## Reference

- `docs/ui/desktop/v2-reference/15-se-activity.png`

## Blocked by

- #15
