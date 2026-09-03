# 347 — Report freshness stamps + auto-escalations cube
Status: done 2026-09-03 — report docs/progress/347-report-freshness-stamps-auto-escalations-cube.md
Type: AFK
Wave: 2 · Severity: P2 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

Every report cube stores the moment it was computed, and no report ever tells the reader. All four
cubes carry `computed_at` (`schema.prisma:2689, 2713, 2748, 2807`), but no report payload returns it —
`reports.service.ts` contains zero `computedAt` / `dataAsOf` — so `ReportsPage.tsx:67,74,240` prints
the **client clock** as "Data as of". The PRD "Data-as-of Timestamp" requirement asks for the data
time, not the time the browser rendered the page.

Bundled with it is **#333**: `system-efficiency-aggregation.service.ts:226-231` counts
`auto_escalations` by *current* status and `updated_at`, so an escalation resolved on the day it was
raised vanishes from that day. #333's own issue file remains the spec for that half of this slice;
this issue only carries it as a bundled deliverable.

## Current code

- `schema.prisma:2689, 2713, 2748, 2807` — the four cubes each store `computed_at`.
- `reports.service.ts` — no `computedAt` / `dataAsOf` anywhere in the report payloads.
- `ReportsPage.tsx:67,74,240` — "Data as of" is the client clock.
- `system-efficiency-aggregation.service.ts:226-231` — intra-day `auto_escalations` leg reads
  current `status` and `updated_at` (#333).

## What to build

- `reports.service.ts` — each cube query returns `MAX(computed_at) AS dataAsOf`; extend the report
  types accordingly.
- `api/reports.ts` — types carry `dataAsOf`.
- `ReportsPage.tsx:67-74,240`, `RootCauseAnalyticsPage.tsx`, `SystemEfficiencyPage.tsx`,
  `ZmScorecardPage.tsx` — print the cube's `dataAsOf` instead of the client clock; label
  "No cube computed yet" when it is null.
- #333 — implement per its issue file (`333-auto-escalations-cube-counts-current-status.md`):
  predicate on `created_at`, and record the historical-recompute decision.
- Tests: the four report e2e specs, `system-efficiency-report.e2e-spec.ts`.

## Acceptance criteria

- [x] AC1 — every `/reports/*` payload carries `dataAsOf` (null when no cube row exists).
- [x] AC2 — the report pages print `dataAsOf` and label "No cube computed yet" when it is null.
- [x] AC3 — #333's acceptance criteria (AC1–AC3 in that file) are met.

## Verification

e2e per `/reports/*` endpoint; admin render test.

## UI surfaces

Admin: Reports (modified) · Root Cause Analytics (modified) · System Efficiency (modified) ·
ZM Performance Scorecard (modified) — the "Data as of" stamp changes source; no layout change.

## Reference

n/a — the plan names no reference image for this slice (stamp text only; no layout change).

## Blocked by

— (none)

## Absorbs / supersedes

- survey ids: RPT-03
- existing issues: #333 (closes into this slice when it lands; its issue file stays the spec for the
  auto-escalations half)
