# 21 — Van Stock + Common Kit Hard Filter + Component-Blocked Queue

Status: partial (backend core done; HITL-scoped 2026-06-24)
Type: AFK
Progress: docs/progress/21-van-stock-common-kit-component-blocked.md — AC#1/#3 done; #2 kit-leg done (expected-component leg deferred to expected_components/Issue 22); #4 overdue badge done (Action Required cross-link deferred); #5 backend done (mobile UI deferred); #6 deferred (no notification spine — Issue 03 HITL). Migration 24. 2026-06-24.

## What to build

Van Stock tracking and the component Hard Filter. `se_van_stock` per-component quantities; the Common Kit completeness check (cables, SIM, antenna, fuse). The component Hard Filter drops a Ticket from a Day Plan when the SE lacks the Common Kit (always) or an out-of-stock Expected Component (when known) — dropped Tickets surface on the **Component-Blocked Queue** (`/component-blocked`, ZM read-only): row per Ticket with SE, missing part(s), Warehouse Manager action status; rows aged >7 days with no WM action gain a "Warehouse Overdue" badge and surface in Action Required. On mobile: SE sees current Van Stock per component; Common Kit completeness badge (green "Kit Complete" / red "Kit Incomplete: [items]") on Home; push when a Common Kit item drops to zero.

## Acceptance criteria

- [x] `se_van_stock` per-component quantities tracked; Common Kit completeness computed
- [~] Hard Filter drops Tickets for incomplete Common Kit (done) or OOS expected components (deferred — needs expected_components, Issue 22)
- [x] Component-Blocked Queue lists dropped Tickets with SE, missing parts, WM action status (ZM read-only)
- [~] Rows aged >7 days with no WM action show "Warehouse Overdue" (done) and surface in Action Required (cross-link deferred)
- [~] Mobile shows Van Stock + Common Kit completeness badge on Home (backend `/api/me/van-stock` done; mobile UI deferred)
- [ ] Push fires when a Common Kit item hits zero (deferred — no notification spine, Issue 03 HITL)

## Blocked by

- #10
- #16
