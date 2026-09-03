# 356 — Intra-day queue hygiene: bounded reads, refresh, labels, dead routes, dead branch
Status: done 2026-09-03 - report docs/progress/356-intraday-queue-hygiene.md
Type: AFK
Wave: 3 · Severity: P2 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

The intra-day queue works but is unbounded, stale and carries dead weight.
`intraday-insertion.service.ts:478-484` returns every insertion ever (552 rows for one ZM) and
`same-day-update.service.ts:104-107` loads every `MANUAL_ZM_UPDATE` audit row. The page loads once
(`IntradayQueuePage.tsx:148`) with no refresh. Manual-assign rows show the raw `ACCEPTED` enum
(`:74-111`). `escalateToZm` returns silently when a zone has no ZM (`:495`; the same at
`stranded-work-escalation.service.ts:118`). Three same-day write routes
(`intraday-updates.controller.ts:40,75,99`) are live with zero callers since #313 made
`/batches/:id/override` the single surface. The comment at `api/schedules.ts:436` is stale after #311.
`notification.service.ts:158-166` `SE_ACCEPTANCE` is dead after CONTEXT §21 retired SE Acceptance
(#268/#279) — §1 re-typed the survey's NOTIF-05 from "gap" to "dead code: delete".

## Current code

- `intraday-insertion.service.ts:478-484` — `listForScope` unbounded; `:495` — `escalateToZm` silent
  when no ZM.
- `same-day-update.service.ts:104-107` — loads every `MANUAL_ZM_UPDATE` audit row.
- `IntradayQueuePage.tsx:148` — single load, no refresh; `:74-111` — raw `ACCEPTED` label.
- `stranded-work-escalation.service.ts:118` — silent return when no ZM.
- `intraday-updates.controller.ts:40,75,99` — add/remove/reorder routes with zero callers (#313).
- `api/schedules.ts:436` — stale comment (#311).
- `notification.service.ts:158-166` — dead `SE_ACCEPTANCE` branch (§21).

## What to build

- `intraday-insertion.service.ts` — `listForScope` gains `take`, `status`, `since` and a cursor;
  `escalateToZm` uses the role-based resolver introduced by #354.
- `intraday-insertion.controller.ts:44` — query DTO.
- `same-day-update.service.ts:104` — bound the read; add an index on `audit_logs(action, created_at)`
  if absent.
- `stranded-work-escalation.service.ts:117-133` — same resolver / logged miss.
- `intraday-updates.controller.ts` — **delete** add/remove/reorder, their service methods and their
  e2e; keep GET (recorded decision: #313).
- `api/intradayInsertions.ts`, `api/intradayUpdates.ts` — remove the dead clients, add the query params.
- `IntradayQueuePage.tsx` — status chips, "since" filter, pager, 30 s refresh while visible plus a
  Refresh button, label "Manager assignment" for ACCEPTED.
- `api/schedules.ts:436` — fix the stale comment.
- `notification.service.ts:158-166` — remove the `SE_ACCEPTANCE` branch and retire
  `NotificationDelivery.firstClass`.
- Tests: `intraday-insertions-controller`, `intraday-critical-insertion`,
  `se-unavailable-stranded-work`, `same-day-update-service` e2e; `intraday-queue.test.tsx`;
  `notification-service.e2e-spec.ts`.

## Acceptance criteria

- [x] AC1 — the default page is ≤ 50 rows, newest first, filterable by status and date, with cursor
      paging.
- [x] AC2 — the queue refreshes without a page reload.
- [x] AC3 — no raw enum label is shown.
- [x] AC4 — a missing ZM → role fallback or a logged miss, never a silent return.
- [x] AC5 — the three same-day write routes return 404 and no client references remain.
- [x] AC6 — the dead acceptance branch is removed and its test rewritten.

## Verification

The e2e and admin tests listed above (the plan names no separate Verification line).

## UI surfaces

Admin: Intra-day Queue page (modified — chips, "since" filter, pager, refresh, relabel).

## Reference

- `docs/ui/desktop/v2-reference/13-intraday-queue.png`

## Blocked by

— (none per the plan; note that `escalateToZm` reuses the resolver #354 introduces — if #354 has not
landed, build the resolver here and let #354 adopt it)

## Absorbs / supersedes

- survey ids: INTRA-G3, INTRA-G5, INTRA-G7, INTRA-G8, INTRA-G9, INTRA-G10, SCH-06, NOTIF-05 (as dead
  code, not a gap), INTRA-G6
- existing issues: #331 — the intra-day half (closes into this slice when it lands; the cross-zone
  half goes to #354)

## Decisions recorded

- **356 deletion — Delete the three uncalled same-day write routes?** #313 made
  `/batches/:id/override` the single surface. Default assumed by the plan: **delete** add/remove/reorder
  (and their service methods and e2e); keep the GET. Strategic HITL (architecture / backlog ownership);
  does not block this wave.
