# 335 — The Assignment History tab crashes on a payload without `attempts`, and it takes the admin suite's exit code with it
Status: ready-for-agent
Type: AFK
Wave: 4 · Severity: P2 · Found 2026-09-03 while landing [#313](./313-single-override-surface.md)

## Problem

`TicketDetailDrawer.tsx:440` reads `attempts.attempts.length` without guarding `attempts.attempts`.
When the attempts payload arrives without that array the component throws
`TypeError: Cannot read properties of undefined (reading 'length')` during render, which React
escalates to an uncaught exception rather than an empty tab.

Two distinct costs:

1. **For the operator**, the Assignment History tab of the ticket drawer goes blank/unmounted on a
   payload shape the component itself already treats as optional two lines earlier (`attempts.isSpecial`
   and `attempts.countableAttempts` are read off the same object without a guard, so the object exists
   — only the array is missing).
2. **For CI**, `vitest` reports the run as `Errors 1 error` and **exits 1 with every test passing**.
   The full admin suite currently reports `119 files / 832 tests passed` and exit code 1. That is
   exactly the failure mode [#107](./107-ci-concurrency-guard-migration-tests.md) adds an AC for
   ("assert vitest's own exit code, never pipe through `tail`") — an unattended pipeline cannot tell
   this from a real failure, and a human reading the summary line cannot see it at all.

## Root cause

An unguarded array read on an optional leg of the payload. `test/ticket-drawer-tabs.test.tsx` renders
it and passes — the throw happens after the assertions, so nothing fails; it only surfaces in vitest's
unhandled-error channel.

## Affected files / symbols

`apps/admin/src/pages/tickets/TicketDetailDrawer.tsx` (~:440, the Assignment History tab);
`apps/admin/test/ticket-drawer-tabs.test.tsx` (the fixture that reproduces it).

## Intended behavior after fix

An attempts payload with no `attempts` array renders the same "This ticket has never been dispatched."
empty state a zero-length array renders. The admin suite exits 0.

Check the sibling reads on the same object (`isSpecial`, `countableAttempts`, `threshold`) while there:
the fix is only worth making once if it makes the whole tab tolerant of the shape rather than one line
of it.

## Implementation boundaries

Frontend only; no API change. Do **not** paper over it by widening the test's fixture — the payload
shape reaching this component in the test is a shape it must survive.

## DB / API / frontend impact

Frontend only.

## Dependencies

None.

## Regression risks

None expected; the change is a guard on a render path.

## Tests required

- The existing `ticket-drawer-tabs` case renders with no unhandled error (`vitest` reports `0 errors`).
- A case that renders the tab with the array absent and asserts the empty state, so the guard is
  pinned rather than incidental.

## Acceptance criteria

- [ ] AC1 — the Assignment History tab renders its empty state for a payload with no `attempts` array.
- [ ] AC2 — `npx vitest run` in `apps/admin` exits 0 with no unhandled errors.

## UI surfaces

Admin: Ticket detail drawer → Assignment History tab (existing — defect fix only).

## Reference

n/a.

## Blocked by

— (independent)
