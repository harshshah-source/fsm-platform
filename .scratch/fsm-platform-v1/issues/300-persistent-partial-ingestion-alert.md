# 300 — Persistent-PARTIAL ingestion is an alert-grade state, not a log line
Status: **done** (2026-09-02) — report [`docs/progress/300-persistent-partial-ingestion-alert.md`](../../../docs/progress/300-persistent-partial-ingestion-alert.md). One deviation from the "no writer change" boundary, taken deliberately: the run now persists its #299 rejected/repaired tallies into `snapshot_runs.chunk_stats` — a JSONB column that has existed since the original schema and had never been written to. The issue's own DB-impact line ("DB: none") holds — no column, no migration — and the run verdict, the #230 gate and the retry logic are byte-identical. Without it the card cannot show "rejected-row totals by reason", which this issue lists as its content and names as the reason it depends on #299: those counters rode `SnapshotRunResult` and a WARN log only, so they ceased to exist the moment the process moved on. F10 settled in favour of reporting the PARTIAL watermark under its own name (AC3, below).
Type: AFK
Wave: 1 · Severity: P2 (operational half of the P1 pair) · Findings: AR-1/AR-2 surfacing + F10,
`audit/2026-09-01-scheduler-engine-forensics.md` §7

## Problem

When ingestion is wedged (AR-1/AR-2, or any repeated PARTIAL), the freeze is loud in logs but
surfaces nowhere an operator looks: the #230 gate silently skips recompute/auto-recovery/ticket
creation every tick, and the freshness banner reads `dataAsOf` from the last SUCCESS run
(`snapshot-query.service.ts:45-53`) — growing staler with no statement of *why*. Related
inconsistency (F10): the worker persists `dataAsOf` for PARTIAL runs
(`snapshot-ingestion.worker.ts:135-139`) that the banner never reads — the two components disagree
about what that value is for.

## Root cause

No read surface aggregates consecutive non-SUCCESS runs or rejected-row counts; the Integration
Health page reports identities, not run-streak health. (#218's `quietRunsAlert` is the in-repo
precedent for exactly this shape of check.)

## Affected files / symbols

- `apps/backend/src/ingestion/snapshot-query.service.ts` (or the integration-health service that
  already aggregates run health) — new streak/rejection read
- `apps/admin/src/api/integrationHealth.ts` + the Build/Integration Health page — render the state
- Read-only inputs: `snapshot_runs` ledger, #299's rejected-row counters

## Intended behavior after fix

- A derived state — N consecutive non-SUCCESS snapshot runs (N configurable, default small, e.g.
  3) or a repeating identical chunk failure — surfaces on the Integration Health page as an
  alert-tone card naming: the streak length, the failing chunk/device id and error, rejected-row
  totals by reason, and the fact that downstream stages are gated off.
- The freshness banner states *why* it is stale when the staleness is a gated pipeline, not just
  the age.
- Resolve the F10 disagreement explicitly: either the banner also reports the newest PARTIAL
  `dataAsOf` as "partial data through …", or the PARTIAL write is documented as diagnosis-only —
  one recorded decision, both components agreeing.

## Implementation boundaries

- Read-side + one derived alert state only. No change to run finalization, the gate, retries, or
  any writer. No new notification channel (the in-app page is the surface; a push is out of scope).

## DB / API / frontend impact

DB: none (derived at read). API: additive field(s) on the existing integration-health response.
Frontend: one card/banner on an existing page.

## Dependencies

#299 (its rejection reasons are this card's content — the streak half works without it).

## Regression risks

Minimal (read-only). Avoid alert fatigue: a single isolated PARTIAL is not the state; the streak is.

## Tests required

- Service: streak derivation (3× PARTIAL same chunk → alert; SUCCESS resets; isolated PARTIAL →
  no alert).
- Admin: card renders name+reason from a fixture payload; absent state renders nothing.

## Acceptance criteria

- [x] AC1 — a wedged pipeline is visible on Integration Health within one page load, naming the
      failing row/chunk and the gated stages. `IngestionAlertCard` on the Build Health page names the
      streak, the failing run/chunk + its verbatim error, whether that error repeats every run, the
      rejected/repaired totals by reason, and the three stages #230 has been skipping.
- [x] AC2 — the freshness banner and the alert agree (no "fresh" claim while gated). Both surfaces
      call ONE derivation over ONE source (`readIngestionAlert` + `prismaIngestionAlertSource`), pinned
      by an e2e asserting `banner.ingestion` deep-equals the card's payload. A gated pipeline drops the
      grey "data as of" line entirely rather than adding a warning beside it.
- [x] AC3 — the F10 `dataAsOf`-on-PARTIAL question is settled in code and stated in a comment.
      **Decision: the PARTIAL write stays and is REPORTED, under its own name.** It is the high-water
      instant of the chunks that did land, and three things read it (the PARTIAL resume floor,
      integration-health freshness, and now the banner). What it must never become is the plain "data
      as of" figure, which stays SUCCESS-only — a partial read may not advance the number an operator
      reads as covering the whole fleet. Recorded at the `finishRun` call in
      `snapshot-ingestion.worker.ts` (the line the finding was about) and on `partialDataAsOf` in
      `snapshot-query.service.ts`.

## UI surfaces

Admin: Build/Integration Health page (existing — one additive card/banner).

## Reference

The built page is the authority (no v2 reference image exists for integration health — same
posture as #252 recorded for the dispatch pages).

## Blocked by

299 (soft — streak half can land first)
