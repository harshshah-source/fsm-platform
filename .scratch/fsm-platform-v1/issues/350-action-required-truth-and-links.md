# 350 — Action Required tells the truth and goes somewhere
Status: ready-for-agent
Type: AFK
Wave: 2 · Severity: P1 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

The Action Required panel is the dashboard's front door and most of it is painted shut.
`dashboard.service.ts:889-901` wires 4 of 9 cards; the other five return `{count: 0, available: false}`
and the panel prints "coming soon" (`ActionRequiredPanel.tsx:45-47`). No card has an `onClick`
(`:27-52`), although `pages/dispatch/console/AttentionBand.tsx:30-38` already holds the destination
map for exactly these categories. CSM and OH dashboards render no panel at all
(`CentralDashboard.tsx:24-45`, `OpsHeadDashboard.tsx`). `ManagerDashboard.tsx:94-97` still fetches
`apiZoneEngineers()` for a consumer #277 removed.

## Current code

- `dashboard.service.ts:889-901` — 4 of 9 cards wired; five return `{count:0, available:false}`.
- `ActionRequiredPanel.tsx:45-47` — "coming soon"; `:27-52` — cards have no `onClick`.
- `pages/dispatch/console/AttentionBand.tsx:30-38` — existing destination map.
- `CentralDashboard.tsx:24-45`, `OpsHeadDashboard.tsx` — no panel mounted.
- `ManagerDashboard.tsx:94-97` — dead `apiZoneEngineers()` fetch (consumer removed by #277).

## What to build

- `dashboard.service.ts:883-901` + five count helpers:
  - `unreviewed_batches` — today's `DispatchRun` / batches with `OVERRIDDEN=false` not yet viewed;
    define as batches dispatched today, zone-scoped.
  - `critical_insertions_awaiting_accept` → rename to `critical_escalations_pending` =
    `IntradayInsertion` rows in `ESCALATION_REQUIRED` that are open (§21: no acceptance step).
  - `component_blocked` = `ComponentBlockedQueue` open rows.
  - `non_op_awaiting_manager` = `NonOperationalMarking` pending.
  - `manual_assignment_required` = OPEN + UNASSIGNED tickets past the dispatch window today.
- `ActionRequiredPanel.tsx` — cards become `Link`s via a shared `lib/actionRequiredDestinations.ts`
  extracted from `AttentionBand.tsx`.
- `CentralDashboard.tsx`, `OpsHeadDashboard.tsx` — mount the panel, zone-filtered.
- `ManagerDashboard.tsx:45,94-111,150-152` — drop the dead engineers fetch.
- Tests: `dashboard-action-required.e2e-spec.ts`, `dashboard-critical-action.test.tsx`.

## Acceptance criteria

- [ ] AC1 — all nine cards return real counts, zone-scoped for ZM.
- [ ] AC2 — each card links to the surface that lists its rows, with the matching filter applied.
- [ ] AC3 — CSM and OH see the panel pan-India.
- [ ] AC4 — no "coming soon" remains.
- [ ] AC5 — the dead engineers fetch is gone.

## Verification

e2e per card with seeded rows; admin link test.

## UI surfaces

Admin: ZM dashboard (modified) · CSM dashboard (modified — panel mounted) · OH dashboard
(modified — panel mounted).

## Reference

- `docs/ui/desktop/v2-reference/01-dashboard-zonal-manager.png`
- `docs/ui/desktop/v2-reference/03-dashboard-central-service.png`
- `docs/ui/desktop/v2-reference/04-dashboard-operations-head.png`

## Blocked by

— (none)

## Absorbs / supersedes

- survey ids: DASH-G02, DASH-G03, DASH-G05, DASH-G08
- existing issues: — (none)
