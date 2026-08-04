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

### 2026-08-04 — the admin setter is missing `AVAILABLE`, which the backend now permits managers to set

From the cross-surface contract audit (`audit/mobile-contract-sync-audit-2026-08-04.md`, finding D7).
**This issue's AC#2 is accurate as written** — it lists the four statuses that were settable when this
was built. The gap is that the set grew and the admin page did not follow.

Verified 2026-08-04: `engineers.controller.ts:70` now includes `AVAILABLE` in `SETTABLE_STATUSES`, and
`se-availability.service.ts:103-107` applies **no status narrowing to the ZM/CSM branches** — only the
SE self-set branches are narrowed (`:101-102`, per #162). So a manager may set `AVAILABLE` over HTTP
today. Admin cannot: `apps/admin/src/api/engineers.ts:19` types `SettableStatus` as the original four,
and `SeManagementPage.tsx:26` / `:305-309` render only those.

Consequence: **no manager can clear an SE's availability window from the console.** Only the SE can,
from the handset — which is precisely the hole #87's 2026-07-28 comment warned about
(*"`SOFT_UNAVAILABLE` is today unrecoverable through the API entirely and needs a DB edit"*). #162 and
#87 closed the SE half on 2026-08-04; the manager half was never re-opened here because this issue was
already `accepted`. If an SE self-sets unavailable and then loses the phone, the recovery path
currently requires the device that is gone.

Also recorded from the same audit: this page renders `SOFT_UNAVAILABLE` as a raw token with the
**critical/red** fallback tone (`SeManagementPage.tsx:36,133,286`) and omits it from the metric strip
(`:25` counts 5 of 9 activity statuses, so the cards do not sum to the rows) — an SE legitimately using
the #87 feature reads as a red alert to their manager.

Setter gap → [#207](./207-admin-queue-filter-availability-completeness.md).
Label/tone gap → [#208](./208-label-vocabulary-parity.md). Not re-opened here.
