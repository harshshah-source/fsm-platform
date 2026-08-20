# 278 — The SE detail panel can show an earlier day's plan as "today's"

Status: needs-triage
Type: AFK · Backend + Admin (small)
Filed: 2026-08-20, from #269's build. Not fixed there — see "Why it was not folded in".

## Objective

`GET /api/engineers/:seId` answers "what is this engineer working *today*" with the plan it actually
means, rather than with whichever live schedule was dispatched most recently.

## Current behaviour (verified)

`EngineersQueryService.currentDayPlan` and `currentAssignments`
(`engineers-query.service.ts`) both resolve the SE's schedule as:

```ts
findFirst({ where: { seId, ...liveScheduleFilter() }, orderBy: { dispatchedAt: 'desc' } })
```

There is **no date predicate**. An earlier day's schedule that is still `ACTIVE` — the closure sweep
has not run, or it was `OVERRIDDEN` and left live — is a legitimate match, and if it sorts first the
panel presents it as the engineer's current day plan: `dayPlan.ticketCount`, the schedule header dates
and every plant stop come from the wrong day.

This is the same defect class #147 fixed for the SE's own Day Plan
(`day-plan-query.service.ts:37` — "the date predicate, not the ordering, decides which plan is
today's") and that #269 fixed for the directory's load count. The detail panel was missed by both.

## Why it was not folded into #269

#269's shared `committedDayLoad` closed the *capacity* half — the SE directory's `activeTicketCount`
is now date-scoped and agrees with the recommender. This is the neighbouring read and it is **not** a
capacity question: it is "which schedule is the current one", and answering it means deciding what a
genuinely multi-day plan (`dateFrom < today <= dateTo`) should show. That is a small design call, not
a drive-by, and #269 had no acceptance criterion covering it.

## Required change

1. Add the date predicate — `dateFrom <= today AND dateTo >= today`, `today` from `istDate` (§19) —
   to both `currentDayPlan` and `currentAssignments`, keeping `dispatchedAt desc` as the tiebreak
   among schedules that genuinely cover today, exactly as `day-plan-query.service.ts` does.
2. Decide and record what the panel shows when no schedule covers today but a live one exists for
   another day: nothing (`dayPlan.status: null`, the honest answer) versus the stale plan labelled
   with its own dates. Prefer the former — it matches the SE's own Day Plan, and a panel that shows
   old work unlabelled is worse than one that shows none.

## Existing code to reuse

`istDate` (`common/ist-day.ts`); the predicate shape in `day-plan-query.service.ts:37`;
`liveScheduleFilter`.

## Data model / API

None. Response shape unchanged — only which schedule populates it.

## UI surfaces

Admin SE Management detail panel (`SeManagementPage`). No layout change; no new reference needed.

## Acceptance criteria

- [ ] An SE whose only live schedule is dated before today reads `dayPlan.status: null` with no stops,
      not that schedule's contents.
- [ ] An SE with plans for both an earlier day and today gets **today's**, regardless of which was
      dispatched later.
- [ ] A multi-day schedule spanning today is still returned (the predicate is a range test, not an
      equality test).

## Tests

Backend e2e beside the existing `engineers-detail.e2e-spec.ts`, with the older schedule given the
*later* `dispatchedAt` so ordering alone cannot produce the right answer.

## Dependencies / Blocked by

None. #178's closure recycle makes the stale-plan population shrink, but this is the defence that does
not depend on a sweep having run.

## Risks

Low. Read-only, one predicate, mirroring a predicate already proven on the SE's own day plan.

## Rollback

Trivial.
