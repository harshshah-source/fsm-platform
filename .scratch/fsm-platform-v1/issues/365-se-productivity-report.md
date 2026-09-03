# 365 — SE productivity report
Status: done 2026-09-04 — report docs/progress/365-se-productivity-report.md
Type: HITL (design stop, cleared 2026-09-03 by #368) then AFK
Wave: 5 · Severity: P3 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

The PRD (`:33`, `:340`, story 25) names SE productivity as a report on `/reports`; no route,
endpoint or page exists. The raw material does: `fleet.seRepairedClosures`
(`reports.service.ts:322-333`), the `se_id` dimension of `system_efficiency_summary_daily`, and
`me-work-history.service.ts`.

Prerequisite: audit finding F7 — `se_repaired_closures` mis-attributes departure closures
(`fleet-uptime-aggregation.service.ts:89-94`) and must be split by `closure_type` before any
per-SE number is trustworthy.

## Current code

- `apps/backend/src/reports/reports.service.ts:322-333` — `fleet.seRepairedClosures`.
- `apps/backend/src/reports/fleet-uptime-aggregation.service.ts:89-94` — closure attribution
  without a `closure_type` split (F7).
- `system_efficiency_summary_daily` — has an `se_id` dimension.
- `apps/backend/src/me-work-history/me-work-history.service.ts` — per-SE work history read.
- No route in `reports.controller.ts`, no client in `api/reports.ts`, no page, no nav entry.

## What to build

- `fleet-uptime-aggregation.service.ts:89-94` — split `se_repaired_closures` by `closure_type`
  (F7) first.
- `reports.service.ts` — new method; `reports.controller.ts` — new route (OH/CSM all zones, ZM
  own zone).
- `api/reports.ts` — client.
- New `pages/reports/SeProductivityPage.tsx`; `AppRoutes.tsx`; `lib/nav.ts`.
- New e2e spec.
- Only after the design stop below has produced an approved design.

## Acceptance criteria
- [x] AC1 — per-SE closures by type, first-time-fix rate, failed-verification rate, and average
      on-site → submission time; weekly and monthly; computed from the summary tables; zone
      clamped for ZM.
      **Met, with one clause deliberately not met: "computed from the summary tables".** No summary
      table can serve it — `system_efficiency_summary_daily` populates `se_id` on legs 5 and 7 only
      (auto-assignments, overrides); the closure, verification and stage-time legs all write
      `se_id = NULL`, and no cube carries a closure-type split. Serving it from a cube needs new
      columns and `schema.prisma` was owned by #366 this round, so the read is a bounded live query
      with the honest `dataAsOf` #347 gives the other two non-cube reports. Follow-up 1 in
      `docs/progress/365-se-productivity-report.md` restores the cube path.

## Verification

New e2e spec for the endpoint (values from seeded summary rows, ZM clamp); admin render test for
the page once the design exists.

## UI surfaces

Admin: SE Productivity report page under `/reports` (new); nav entry (modified).

## Reference

No v2 image and no approved design exists for this page. This is a **design stop**: per the
plan, produce one under `docs/ui/desktop/approved-designs/` before building the page. The
backend half (F7 split, endpoint) may proceed once that design is approved and the slice flips to
`ready-for-agent`.

## Blocked by
- ~~#346 — fleet-uptime honesty + monthly cube coverage.~~ Closed.
- ~~Design stop — an approved design under `docs/ui/desktop/approved-designs/` (HITL).~~ Cleared
  2026-09-03 by the operator: `docs/ui/desktop/approved-designs/se-productivity-report.html`, with
  the reasoning in `368-decision-se-productivity-report.md`. That file is this page's reference.

## Absorbs / supersedes
- survey ids: RPT-05.
- existing issues: none.
