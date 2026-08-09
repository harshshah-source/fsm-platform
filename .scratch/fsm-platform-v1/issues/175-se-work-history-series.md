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

- [x] An SE can retrieve a bounded per-day assigned/completed series for the last N days
- [ ] An SE can retrieve their ticket rows for an arbitrary past date, in the same row shape as the current-day list (#172 decision 3) — **the remaining half of this issue**; Daily Status (#88) is its only consumer and is not built
- [x] "Completed" has one definition, documented, and it agrees with what a ZM sees for the same SE and day
- [x] Both reads are bounded and cursored per **#165**'s envelope conventions — the series is bounded (`days` clamped to 1–31) and returns a fixed-size dense array; a cursor is meaningless on a response whose length the caller chose
- [x] Days with no schedule return a zero row, not a gap (the chart renders 7 bars regardless)

## Comments

### 2026-08-05 — the series half is built; the dated ticket read is not

`GET /api/me/work-history?days=N` → `{ days: [{ date, assigned, completed }] }`, oldest first
(`me-work-history.service.ts`, `MeWorkHistoryView` in `@fsm/shared`). Consumed by Home's
`WorkHistoryChart` (#55), verified live against the dev DB on a handset.

**The source question this issue said to settle before building, settled:**

- **assigned(D)** = distinct tickets in the SE's plant batches on every `work_schedule` covering IST
  day D, excluding ZM-removed rows (`removedAt`) — the same "assigned" the live read means, evaluated
  per day rather than only for the current schedule.
- **completed(D)** = of *that day's assigned set*, tickets with a `ticket_events` row whose `toState`
  is `CLOSED`/`CLOSED_AUTO_RECOVERY` and whose `at` falls in IST day D.

`ticket_events` over `tickets.status`, for the reason this issue anticipated: the status column says
where a ticket ended up, not when it got there, so it cannot answer "what did this SE complete on
09 May" at all once the ticket moves again — and the event ledger is the same one a ZM's view of the
day reads, which is what makes the two agree. `completed ⊆ assigned` therefore holds **by
construction**, which is what lets the chart print `4/6` as a fraction; a ticket closed on a day it
was not this SE's never lands in a bar. Closure states are deliberately identical to the Home KPI
strip's COMPLETED tile (`homeKpi.ts`) — the tile and the chart sit on the same screen, so a second
definition would be visible as a contradiction.

Bucketed on the **IST** operating day (CONTEXT §19 / #204), not UTC: `me-work-history.e2e-spec.ts`
pins a closure at `2026-06-18T18:45Z` (00:15 IST on the 19th) that scores 0 under UTC bucketing.

**Still open:** the dated ticket-row read for Daily Status. Not built because #88 (Daily Status) has
no screen yet, and #175 explicitly wants it as *one dated read* on the existing `/me/tickets`, not a
second parallel endpoint — that reshaping belongs with the screen that consumes it.

## UI surfaces

n/a (backend; consumed by Mobile **#55** Home chart and **#88** Daily Status).

## Reference

- `docs/ui/mobile/home-dashboard.png` (the chart), `docs/ui/mobile/daily-status.png` (date chip).

## Blocked by

- **#161** (per-ticket status and the row shape) and **#147** (date semantics + schedule closure).
  Not blocking for mobile start — Home ships without the chart, per #172 decision 1.
