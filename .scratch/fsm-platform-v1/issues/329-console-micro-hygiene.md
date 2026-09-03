# 329 — Console micro-hygiene: changes-tab count, Back-button prefill, Escape in a reason field
Status: ready-for-agent
Type: AFK
Wave: 4 · Severity: P3 · Findings: CB-13 + RC-17 (FE edges),
`audit/2026-09-01-scheduler-engine-forensics.md` §6/§8

## Problem
Three small console defects, all in the drag/dialog surface:
1. **CB-13:** the Changes tab truncates at 12 rows (`WorkRail.tsx:413` `slice(0,12)`) with no
   "and N more" while the tab count shows the full total (the unassignable list already scrolls
   untruncated).
2. **Back-button re-open:** after a drop + Cancel, `dropIntent` (React state) survives while
   `?sel` is deleted; browser Back restores `?sel`, `sameSelection` matches again
   (`TodaysDispatchPage.tsx:126-188, 580`) and the stale prefilled dialog re-opens.
3. **Escape discard:** two independent Escape handlers (`TodaysDispatchPage.tsx:255-270` +
   `Modal.tsx:39-46`) close the Inspector from inside a mandatory-reason text field, silently
   discarding the draft.

## Root cause
State that should die with its gesture (dropIntent) outlives it; the Escape guard protects only
the find box; the truncation predates the scrolling pattern.

## Affected files / symbols
`apps/admin/src/pages/dispatch/console/WorkRail.tsx`,
`apps/admin/src/pages/dispatch/TodaysDispatchPage.tsx`,
`apps/admin/src/components/overlay/Modal.tsx` (guard seam only).

## Intended behavior after fix
1. The changes list scrolls untruncated (the unassignable list's pattern) or shows "…and N more".
2. Cancel clears `dropIntent`; Back can restore selection but never a consumed drag intent.
3. Escape from inside a dirty form field first returns focus/confirms, never silently discards a
   typed reason (match: first Escape blurs the field, second closes; or a dirty-check confirm).

## Implementation boundaries
These three behaviors only; no dialog redesign, no changes to commit flows.

## DB / API / frontend impact
Frontend only.

## Dependencies
Coordinate with any live console work (same files). After #313 if it moves shared forms.

## Regression risks
The Escape change must not trap keyboard users — the second-Escape path must always exist
(a11y pin).

## Tests required
RTL: >12 changes all reachable; drop→Cancel→Back does not re-open the dialog; Escape in a dirty
reason field does not lose the draft on first press.

## Acceptance criteria
- [ ] AC1 — every change row is reachable; the count and the list agree.
- [ ] AC2 — a cancelled drag can never resurrect via history navigation.
- [ ] AC3 — a typed reason cannot be lost by a single Escape.

## UI surfaces
Admin: Scheduler Console (existing — behavior only).

## Reference
The built page is the authority.

## Blocked by
313 (soft — shared-form location)
