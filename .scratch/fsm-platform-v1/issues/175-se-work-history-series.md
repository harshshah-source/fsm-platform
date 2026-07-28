# 175 — SE work-history series (Home 7-day chart + Daily Status date selection)

Status: ready-for-agent
Type: AFK · Backend

Filed 2026-07-28, split out of [#172](./172-mobile-screen-contract-ratification.md) decision 1.
**The single genuinely-new backend capability the Home screen ratification introduced** — everything
else on Home derives from per-ticket status, which #161 already owes.

## What the screens need

**Home — "Assigned vs Completed" chart** (`docs/ui/mobile/home-dashboard.png`): a 7-day bar series,
one bar pair per day, labelled `4/6, 5/8, 7/10, 6/7, 5/9, 8/11, 9/12` (completed/assigned) over
`07 May … 13 May`, with a two-series legend (Completed / Assigned).

**Daily Status — historical date selection** (`docs/ui/mobile/daily-status.png`): a date chip
(`10 MAY`) with four counters (assigned / completed / in-progress / pending), a completion
percentage, and the day's ticket rows. **Same dependency, different shape** — this needs the rows
for an arbitrary past date, not just the aggregate.

## Why nothing today can serve it

`GET /api/schedules/me` resolves a **single** schedule — `findFirst` on the SE with
`liveScheduleFilter()`, ordered by `dispatchedAt desc` (`scheduling/day-plan-query.service.ts:41-46`)
— with **no date predicate at all**. There is no per-day history read anywhere on the SE surface,
and nothing writes a terminal `work_schedules.status`, so "what did this SE complete on 09 May" is
not answerable from the schedule table alone.

The completion side has to come from ticket state — either `ticket_events` (which records lifecycle
transitions durably, `schema.prisma:2122-2137`) or the tickets' own closure timestamps. **Decide the
source before building**: a count derived from `ticket_events` and a count derived from
`batch_assignment_tickets` can legitimately differ, and the SE's chart must not disagree with the
ZM's view of the same day.

## What to build

- `GET /api/me/work-history?days=7` (or `?from=&to=`) → `[{ date, assigned, completed }]`, bounded.
- A date parameter on the day-plan/tickets read so Daily Status can request an arbitrary past date's
  rows — coordinate with **#147** (which fixes the missing date filter on the *current* plan) and
  **#161/#165** (which own the merged `GET /api/me/tickets` shape from #172 decision 3). This should
  be **one dated read**, not a second parallel endpoint.
- Whatever terminal-state writing is required to make "completed" well-defined — this may pull in
  #147's schedule-closure leg.

## Acceptance criteria

- [ ] An SE can retrieve a bounded per-day assigned/completed series for the last N days
- [ ] An SE can retrieve their ticket rows for an arbitrary past date, in the same row shape as the current-day list (#172 decision 3)
- [ ] "Completed" has one definition, documented, and it agrees with what a ZM sees for the same SE and day
- [ ] Both reads are bounded and cursored per **#165**'s envelope conventions
- [ ] Days with no schedule return a zero row, not a gap (the chart renders 7 bars regardless)

## UI surfaces

n/a (backend; consumed by Mobile **#55** Home chart and **#88** Daily Status).

## Reference

- `docs/ui/mobile/home-dashboard.png` (the chart), `docs/ui/mobile/daily-status.png` (date chip).

## Blocked by

- **#161** (per-ticket status and the row shape) and **#147** (date semantics + schedule closure).
  Not blocking for mobile start — Home ships without the chart, per #172 decision 1.
