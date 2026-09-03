# 315 — Run-now control and run-status badge stop going stale
Status: ready-for-agent
Type: AFK
Wave: 3 · Severity: P2 · Finding: AR-7, `audit/2026-09-01-scheduler-engine-forensics.md` §7

## Problem

- `RunNowControl.tsx:71-113`: the in-flight pre-check refetches only when `phase` changes, and
  the button is the only thing that changes phase — a run in flight at mount leaves the control
  disabled forever after the run finishes (until a full remount).
- `TodaysDispatchPage.tsx:406-414`: the top-bar `Dispatched …/RUNNING` badge comes from the
  unpolled lifted payload — a RUNNING run stays "RUNNING" on screen indefinitely.

Server-side correctness is unaffected (the 409 path holds); this is stale UI on the two elements
that describe the engine's liveness.

## Root cause

The console deliberately has no polling; these two elements are the places where that design
needs a bounded exception (or an event to refetch on).

## Affected files / symbols

- `apps/admin/src/pages/dispatch/RunNowControl.tsx` (used by TodaysDispatchPage and the dispatch
  pages)
- `apps/admin/src/pages/dispatch/TodaysDispatchPage.tsx` — badge refresh wiring

## Intended behavior after fix

While an in-flight run is known (badge RUNNING or button disabled by pre-check), the affected
element re-checks `GET /schedules/dispatch-run/in-flight` on a bounded interval (e.g. 15–30 s)
and on window focus, stopping when the run terminates; the button re-enables and the badge
resolves without a remount. No global polling is introduced — the interval exists only while a
run is believed live.

## Implementation boundaries

- Scoped polling only while RUNNING is displayed; no console-wide refetch loop; no backend change
  (`in-flight` already exists and is cross-instance truthful per #259).

## DB / API / frontend impact

Frontend only (bounded extra reads of an existing cheap endpoint).

## Dependencies

None. Pairs naturally with #314 in one PR if convenient.

## Regression risks

- Interval leaks: the timer must die with the component and with run termination (RTL pin with
  fake timers).

## Tests required

- RTL (fake timers): run in flight at mount → run finishes server-side → button re-enables and
  badge resolves within one interval; timer cleared on unmount.

## Acceptance criteria

- [ ] AC1 — neither element can stay in a RUNNING/disabled state after the run has terminated,
      without a remount.
- [ ] AC2 — zero polling occurs when no run is believed live.

## UI surfaces

Admin: Run-now control + cockpit run badge (existing — behavior only).

## Reference

The built page is the authority.

## Blocked by

— (independent)
