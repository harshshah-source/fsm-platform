# 349 — Integration Health page completion
Status: ready-for-agent
Type: AFK
Wave: 2 · Severity: P2 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

The backend already reports more integration health than the page shows. `IntegrationHealth`
carries `source` connectivity, `masterSync/snapshot.ageMinutes`, `reconciliation` and `lifecycle`
(`health.service.ts:22-156`), but the admin view types only build, lock, recomputes and ingestion
(`api/integrationHealth.ts:48-55`), and `BuildHealthPage.tsx:81-111` renders three cards.
`GET /snapshots/runs` (`snapshots.controller.ts:34-46`) has no consumer at all. Departure
auto-closes are audited (`device-departure.service.ts:373,411`) but appear nowhere an operator can see.

The survey (§1) narrowed this: drift already has a screen (`ReconciliationPanel.tsx`, OH), so the real
drops are connectivity, freshness age and lifecycle. ING-09 ("one health section untestable on the
running build") is precondition P0-b (restart the dev backend on HEAD), not part of this slice.

## Current code

- `health.service.ts:22-156` — backend `IntegrationHealth` carries `source` connectivity,
  `masterSync/snapshot.ageMinutes`, `reconciliation`, `lifecycle`.
- `api/integrationHealth.ts:48-55` — admin type covers only build, lock, recomputes, ingestion.
- `BuildHealthPage.tsx:81-111` — renders three cards.
- `snapshots.controller.ts:34-46` — `GET /snapshots/runs` has no consumer.
- `device-departure.service.ts:373,411` — departure auto-close is audited, unsurfaced.

## What to build

- `api/integrationHealth.ts` — the full `IntegrationHealth` type.
- `BuildHealthPage.tsx` — add sections: Connectivity; Freshness age; Lifecycle (missing-from-source /
  quiet runs / departures & restores per run / tickets auto-closed by departure); Run history table
  fed from `api/snapshots.ts` + a new `apiSnapshotRuns` client.
- Backend `integration-health` — per-run departure counters, if not already on the payload.
- Tests: `build-health-page.test.tsx`, `integration-health-api.e2e-spec.ts`.
- Scope note: the dashboard tally and the device-detail history of #129 stay in #129; only its
  health-page part lands here.

## Acceptance criteria

- [ ] AC1 — the four dropped sections (connectivity, freshness age, lifecycle, run history) render
      with the live values.
- [ ] AC2 — run history is paged and filterable by status.
- [ ] AC3 — departures / restores / auto-closed counts are shown per run.
- [ ] AC4 — the page stays OH-only (role unchanged).

## Verification

`build-health-page.test.tsx` and `integration-health-api.e2e-spec.ts` (the tests the plan names).

## UI surfaces

Admin: Build Health / Integration Health page (modified — four new sections, OH only).

## Reference

No v2 image exists — the page itself is the authority (#131); extend it, do not redraw.

## Blocked by

- #348 — `overdue` / freshness signals that the new sections display

## Absorbs / supersedes

- survey ids: ING-02 (narrowed to connectivity, age, lifecycle), ING-04, ING-01 (the surfacing half —
  the pushed notice is #361), AC-10
- existing issues: #224 (closes into this slice when it lands); the health-page part of #129 (closes
  into this slice when it lands — #129 keeps the dashboard tally and device-detail history)
