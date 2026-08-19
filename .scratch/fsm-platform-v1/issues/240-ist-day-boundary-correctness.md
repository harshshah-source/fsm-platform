# 240 — IST day-boundary correctness: closure cron timezone, planner date, manual-assign date

Status: done (2026-08-19)
Type: AFK · Backend

Filed 2026-08-19 from the approved scheduler-decisions plan
(`docs/audits/scheduler-slice-plan-2026-08-19.md`; verification:
`docs/audits/four-decisions-final-analysis-2026-08-18.md` §4). Three same-family UTC-vs-IST defects,
one theme. Prerequisite of #242 (recycling depends on closure running *before* dispatch).

## What to build

### Current behaviour (verified at `0b72976`)

1. `scheduling/schedule-closure-scheduler.service.ts:91` — `@Cron(readScheduleClosureConfig().closureCron, { name: 'schedule-closure' })`
   has **no `timeZone` option** (the dispatch cron at `dispatch-scheduler.service.ts:63` passes
   `timeZone: BUSINESS_TIMEZONE`). On a UTC host, `0 4 * * *` fires at **09:30 IST — 4.5 h AFTER the
   05:00 IST dispatch**, inverting the closure-before-dispatch ordering. The file's own docstring is
   self-contradictory: it says "daily at 04:00 UTC, i.e. ahead of … the 05:00 dispatch tick" and
   "the crons are an hour apart (04:00 vs 05:00)" — both false across timezones.
2. `recommender/recommender.service.ts:590-591` — `plannerForDate` derives its day with
   `new Date(Date.UTC(now.getUTCFullYear(), …))` instead of `istDate(now)`. Between 00:00–05:29 IST
   it reads the **previous** IST day's `se_planner` rows.
3. `scheduling/override.service.ts:282` — `assignTicket` derives the schedule day the same wrong way
   (`Date.UTC`). A manual assign between 00:00–05:29 IST lands on / creates a schedule dated the
   previous IST day — a different day than the 05:00 dispatch (which uses `istDate`) would use.

### Required change

- Closure cron: add `timeZone: BUSINESS_TIMEZONE` (import from `scheduling/dispatch-cron.ts`);
  document `SCHEDULE_CLOSURE_CRON` as an IST expression; correct the docstring's two false claims.
  (Making it settings-driven like `dispatch_cron` is optional scope — the timeZone fix is the
  requirement.)
- `plannerForDate` and `assignTicket`: derive the day via `istDate(now)` (`common/ist-day.ts`).
- No schema, API, or UI change. No behaviour change outside the 00:00–05:29 IST window and the
  cron firing time.

### Existing code to reuse

`common/ist-day.ts` (`istDate`), `scheduling/dispatch-cron.ts` (`BUSINESS_TIMEZONE`,
the settings-driven cron precedent in `dispatch-schedule.service.ts` if extended).

### Tests

- Unit: both date derivations at boundary instants (23:59 IST, 00:01 IST, 05:29 IST, 05:31 IST) —
  planner rows and manual-assign schedule dates land on the IST day.
- Pin: closure config resolves with the IST timezone (a registration-shape test in the style of the
  #238 route-order pin), so a future edit cannot silently drop it.

### Risks / rollback

Behaviour *corrects* in the night window (a manual assign at 01:00 IST now lands on today's plan,
not yesterday's). No data migration; rollback = revert the commit.

## Acceptance criteria

- [x] AC1 — The `schedule-closure` cron is registered with `timeZone: BUSINESS_TIMEZONE`; on a
      UTC-clock host the closure tick precedes the dispatch tick for the same IST day.
- [x] AC2 — `plannerForDate(zoneId, now)` returns rows for the **IST** date of `now` across the
      00:00–05:29 IST window (boundary unit tests).
- [x] AC3 — `assignTicket` finds/creates the schedule for the **IST** date of `now` across the same
      window, matching what `dispatchForZone` uses for the same instant.
- [x] AC4 — The closure docstring no longer claims "04:00 UTC … ahead of 05:00" or "an hour apart";
      it states the IST ordering.

## UI surfaces

n/a

## Reference

n/a (backend-only)

## Blocked by

Nothing. Blocks #242.
