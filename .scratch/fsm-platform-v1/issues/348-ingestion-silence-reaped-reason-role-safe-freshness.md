# 348 — Ingestion silence detection, reaped-run reason, role-safe freshness
Status: ready-for-agent
Type: AFK
Wave: 2 · Severity: P1 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

A stopped ingestion cron reads as healthy. The alert detectors count runs that *happened*
(`ingestion/ingestion-alert.ts:145-147, 206-209`), so silence — zero runs — trips nothing.
`health.service.ts:44` computes an `ageMinutes` for the latest snapshot but no threshold exists to
judge it, and `SnapshotBanner.tsx:26-33` only flags a run that has been RUNNING for more than
15 minutes.

Two further gaps in the same area: a snapshot run reaped by the heartbeat records no reason
(`snapshot-run.service.ts:39-45`; `SnapshotRun` has no `error` column), and `GET /snapshots/latest`
is restricted to ZM/CSM/OH (`snapshots.controller.ts:28-29`) while the banner swallows the resulting
403 for WM and SE sessions — those roles never see freshness at all.

## Current code

- `ingestion/ingestion-alert.ts:145-147, 206-209` — detectors count runs that occurred; no
  "no run at all" detection.
- `health.service.ts:44` — `ageMinutes` computed, no threshold.
- `SnapshotBanner.tsx:26-33` — flags only RUNNING > 15 min; catches the 403 silently.
- `snapshot-run.service.ts:39-45` — heartbeat reap writes no reason; `SnapshotRun` has no `error`
  column.
- `snapshots.controller.ts:28-29` — `/snapshots/latest` is ZM/CSM/OH only.
- `master-sync-run.service.ts:55-61` — the existing `ORPHANED_RUN_ERROR` pattern to copy.

## What to build

- `ingestion-alert.ts` — add `overdue` when the latest SUCCESS is older than
  `expectedCadenceMinutes × 2`, with the cadence derived from the configured cron.
- `autoplant/health.service.ts` — `freshness.stale`.
- `snapshot-query.service.ts` — `/snapshots/latest` payload carries `overdue`.
- `schema.prisma` — `SnapshotRun.error` + migration.
- `snapshot-run.service.ts:39-45` — reaped runs record `ORPHANED_RUN_ERROR`, like
  `master-sync-run.service.ts:55-61`.
- `snapshots.controller.ts:29` — widen `latest` to all roles (it is freshness, not data).
- `SnapshotBanner.tsx` — overdue renders as a red line; no silent catch.
- Tests: `test/ingestion-alert.spec.ts`, `snapshots-api.e2e-spec.ts`,
  `snapshot-run-lifecycle.e2e-spec.ts`, banner test.

## Acceptance criteria

- [ ] AC1 — zero runs within 2× cadence → `overdue: true`, and the banner is red for every role.
- [ ] AC2 — a reaped run shows `error: ORPHANED_RUN_ERROR` in `/snapshots/runs`.
- [ ] AC3 — WM and SE sessions get the banner.
- [ ] AC4 — no false alert while the scheduler is deliberately disabled — the disabled state renders
      as "ingestion paused", not healthy.

## Verification

Unit + e2e listed above; freeze-clock test for the cadence rule.

## UI surfaces

Admin: Snapshot banner (modified — shown to every role, including WM and SE).

## Reference

n/a — the plan names no reference image for this slice (banner state change only).

## Blocked by

— (none)

## Absorbs / supersedes

- survey ids: ING-03, ING-06, ING-08
- existing issues: — (none)
