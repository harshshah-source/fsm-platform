# 322 — Preview staleness check: wire it or retire it
Status: ready-for-agent
Type: AFK
Wave: 4 · Severity: P3 · Finding: CB-10, `audit/2026-09-01-scheduler-engine-forensics.md` §6

## Problem
`GET /schedules/preview` HMAC-signs and returns `previewToken` on every call
(`scheduler-preview.service.ts:123`), and `checkStaleness` (:135-150) is implemented and
unit-tested — but no controller route consumes it. The documented #251 re-poll staleness flow is
unreachable over HTTP; the token is dead weight every client stores for nothing.

## Root cause
The endpoint was never wired (or the flow was superseded without removing the mint).

## Affected files / symbols
`apps/backend/src/scheduling/schedules.controller.ts` (new route) or
`scheduler-preview.service.ts` + `preview-token.ts` (removal);
`apps/admin/src/api/schedulerPreview.ts` + `SchedulerPreviewPage.tsx` (consume or stop storing).

## Intended behavior after fix
Complete #251's documented flow: a route (e.g. `POST /schedules/preview/staleness`) accepting the
token and answering the tested `checkStaleness` shape, consumed by the preview page to prompt a
re-poll. If investigation shows the flow was deliberately superseded (check #251's file and
comments first — do not reinterpret), remove the mint, the token field and the client storage
instead, recording the supersession in #251. Wiring is the default; removal needs the recorded
evidence.

## Implementation boundaries
This flow only; hold mechanics untouched (their races are #306).

## DB / API / frontend impact
API: one additive route (or one removed response field — a breaking change to note in the issue).
Frontend: preview page gains the staleness prompt (or drops dead storage).

## Dependencies
None.

## Regression risks
Removal path: bulk-unassign's tokens are a **separate** mechanism — do not touch them.

## Tests required
Route contract test consuming a stale and a fresh token; admin RTL for the prompt (wire path); or
absence assertions (retire path).

## Acceptance criteria
- [ ] AC1 — no minted-but-unconsumable API surface remains: the token is either consumable over
      HTTP and consumed by the page, or gone.
- [ ] AC2 — the disposition is recorded on #251.

## UI surfaces
Admin: Scheduler Preview page (wire path: one prompt state).

## Reference
The built page is the authority.

## Blocked by
— (independent)
