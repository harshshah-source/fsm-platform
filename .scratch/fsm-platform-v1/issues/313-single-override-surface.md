# 313 — One override implementation: ScheduleDetailPage consumes the console's forms
Status: done (2026-09-03) - see `docs/progress/313-single-override-surface.md`
Type: AFK
Wave: 3 · Severity: P2 · Findings: AR-4 + CB-7,
`audit/2026-09-01-scheduler-engine-forensics.md` §6/§7

## Problem

`ActionsBand.tsx:27-35` claims the ScheduleDetailPage override controls were "moved here … not
copied: one implementation, so #282 R5 holds". The code shows otherwise:
`ScheduleDetailPage.tsx:188-491` still carries a full second implementation of
Remove/Defer/Reassign/Swap/Split/Reorder plus a second copy of `useOverridePreview`
(:188-211 vs `ActionsBand.tsx:1201-1223`). They have already diverged — the console has
MOVE_TICKET, per-form error surfaces, and deferral-aware conflict copy; the legacy page has
**silent failures** (CB-7: `onOverride` re-throws at :87, callers at :246-253/:392-399 are
`try/finally` with no catch — network errors and 4xx/5xx produce an unhandled rejection and no UI
feedback) and no Move.

## Root cause

The absorption the docblock describes was never completed; every change now lands twice or the
two surfaces answer the same gesture differently.

## Affected files / symbols

- `apps/admin/src/pages/schedules/ScheduleDetailPage.tsx` — delete the duplicated controls
  (:188-491) and consume the shared forms
- `apps/admin/src/pages/dispatch/console/ActionsBand.tsx` — export/parameterize the forms if
  needed (no behavior change on the console)

## Intended behavior after fix

ScheduleDetailPage renders the same override forms/components the console renders (one
implementation, one `useOverridePreview`), inheriting error surfaces, MOVE_TICKET, and the
deferral-aware copy. CB-7 closes by construction. The docblock's claim becomes true.

## Implementation boundaries

- Frontend only; no API change. The console's own behavior must be pixel/behavior-identical
  (its six suites are the pin).
- If full absorption proves larger than one slice, the minimum landing is: delete the duplicated
  `useOverridePreview` + add catch-and-render on every legacy commit path (closing CB-7), with
  the remaining absorption filed as a follow-up — do not leave CB-7 open behind a deferred
  refactor.

## DB / API / frontend impact

Frontend only.

## Dependencies

None hard. Coordinate with any in-flight console work on `ActionsBand.tsx`.

## Regression risks

- ScheduleDetailPage's context differs (it knows its schedule; the console derives placement) —
  prop seams must not change the console's `placementOf` behavior.
- OverrideImpactPanel placement on Schedule Detail is an operator-ruled surface (#289) — keep it.

## Tests required

- Existing `schedule-override`, `override-impact-preview`, `deferral-override-confirm` suites
  green against the shared forms.
- New: a failed override on ScheduleDetailPage renders an error message (the CB-7 pin).
- Console suites (six) green unchanged.

## Acceptance criteria

- [x] AC1 — exactly one implementation of the override forms and one `useOverridePreview` exist.
- [x] AC2 — no override failure on any surface is silent.
- [x] AC3 — ScheduleDetailPage gains MOVE_TICKET for free (or records why it is excluded).

## UI surfaces

Admin: Schedule Detail page (existing — same controls, shared implementation);
Scheduler Console (unchanged).

## Reference

The built pages are the authority (no v2 image covers the dispatch pages — #252's recorded
posture).

## Blocked by

— (independent; coordinate on ActionsBand)
