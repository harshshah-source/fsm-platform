# 25 — SE Management page + Activity Status + Set Availability

Status: ready-for-agent
Type: AFK

## What to build

The SE Management page (`/engineers`). SE list: name, coverage type, derived Activity Status badge (AVAILABLE / ON_SITE / BUSY / SHIFT_ENDING / OFFLINE — computed at render time, never stored), today's Ticket count, Common Kit completeness chip. Click an SE → detail panel: current Day Plan status, Van Stock per component (missing in red), availability rows. ZM action: **Set Availability** (ON_LEAVE / OFF_SHIFT / WEEKLY_OFF / SOFT_UNAVAILABLE + time window) writing to the single time-windowed `se_availability` table. Setting an SE unavailable excludes them from Recommender candidate scoring for that window. ZM and SE are the only setters; Operations Head has no role here.

## Acceptance criteria

- [ ] SE list shows derived Activity Status (render-time), coverage type, today's ticket count, kit chip
- [ ] SE detail panel shows Day Plan status, per-component Van Stock (missing in red), availability rows
- [ ] Set Availability writes ON_LEAVE / OFF_SHIFT / WEEKLY_OFF / SOFT_UNAVAILABLE with a time window
- [ ] Unavailable SEs excluded from Recommender candidate scoring for the window
- [ ] ZM scoped to own zone; Operations Head has no setter role here

## Blocked by

- #15
