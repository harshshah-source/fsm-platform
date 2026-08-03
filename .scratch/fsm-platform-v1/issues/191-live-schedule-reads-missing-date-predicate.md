# 191 — Five sibling schedule reads carry #147's missing date predicate

Status: ready-for-agent
Type: AFK · Backend

Filed 2026-08-04 while executing [#147](./147-day-plan-date-filter-schedule-closure.md). Parent stays
**accepted** — #147's acceptance criteria name `getDayPlan` and the lifecycle only, and its Slice 2
closer fixes every read below *by construction*. This issue owns the read-side guard that holds even
when the closer is off.

## Problem

`getDayPlan` was not the only reader with the shape #147 diagnosed. Five more spell
`liveScheduleFilter()` + `orderBy: { dispatchedAt: 'desc' }` with **no date bound**, so each resolves
"the SE's current schedule" as "the newest live one, whatever day it covers":

| file | surface | what a stale schedule does |
|---|---|---|
| `engineers-query.service.ts:186` | SE detail — schedule + stops | shows yesterday's stops as current |
| `engineers-query.service.ts:260` | SE directory — today's day-plan ticket count | counts yesterday's tickets as today's load |
| `me-tickets-query.service.ts:91` | **SE mobile** — which tickets count as assigned | yesterday's assignments render as today's |
| `me-tickets/se-ticket-access.ts:42` | **SE mobile authorization** — may this SE read this ticket | grants read on yesterday's tickets |
| `zm-schedule-query.service.ts:90,118` | ZM Schedules page | lists every accreted live schedule, not today's |

`me-tickets-query.service.ts` already receives a `now` (`getMyTickets(seId, now = new Date())`) and
uses it elsewhere — it simply never reaches the schedule lookup.

## Why it is not already closed by #147

#147 Slice 2's closer writes `COMPLETED`/`PARTIAL` onto past-dated schedules, which removes them from
`LIVE_SCHEDULE_STATUSES` and therefore from all five reads. That is the real fix and it is landed.

But it holds only while the closer runs: `BUSINESS_SWEEPS_ENABLED` **defaults OFF**, the tick is daily,
and a zone whose dispatch holds the advisory lock is skipped to the next tick. Between those, every read
above is exposed — and two of them are on the SE mobile path that #147's own 07-28 comment reclassified
as mobile-blocking. Defence in depth: the state should be honest *and* the read should not depend on it.

## Not a mechanical predicate copy

`se-ticket-access.ts` is **authorization**, not display, and needs a product answer first: should an SE
keep read access to a ticket they worked yesterday (to file a late report, re-check what they did) or
lose it at midnight? Date-filtering it without deciding that would silently revoke access. The other
four are display/counting reads where "today" is unambiguously meant — `engineers-query.service.ts:260`
is documented as *"today's day-plan ticket count"* and does not filter to today.

## Acceptance criteria

- [ ] The four display/counting reads bound the schedule to the caller's day, reusing
      `common/utc-day.ts` — no fifth private copy of "today".
- [ ] Each takes an injectable `now` in the `getDayPlan(seId, { now })` / `getMyTickets(seId, now)`
      shape already used, so fixtures state their own clock.
- [ ] `se-ticket-access.ts` is resolved explicitly — either date-bounded or documented in-code as
      deliberately unbounded with the reason. **Escalate the access-window question (Strategic HITL:
      business rule) before changing it.**
- [ ] One RED per read proving a past-dated schedule no longer leaks, in the #147 three-case style.
- [ ] `zm-schedule-query` keeps showing a ZM the schedules they must act on — confirm against
      `docs/ui/desktop/v2-reference/` before narrowing that list.
- [ ] Backend suite green.

## Reference

`docs/progress/147-day-plan-date-filter-schedule-closure.md` §"Found, not fixed".

## Estimated effort

S. **Priority: P2** — the closer already covers the common case; this is the guard for when it does not.
