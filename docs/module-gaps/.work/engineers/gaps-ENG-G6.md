# ENG-G6 — a manager cannot take an engineer off leave (walk, 2026-09-02, E4)

**New at S3.** Filed separately from ENG-G4 because it blocks ENG-G4's claim and needs a different
fix. This is the finding of the walk.

## The claim under test
`SeAvailabilityService.setAvailability` lets a ZM write `status: 'AVAILABLE'` — the comment at
`:104-110` calls it "the clearing status … the one write here that gives an engineer back to the day
rather than taking them from it". So a leave approved by mistake should be recoverable.

## The walk
Starting from the two stacked rows left by ENG-G4 (both `window_start` = `2026-10-04T18:30Z`):

```
POST /engineers/459b5409.../availability
  {"status":"AVAILABLE","windowStart":"2026-10-05","windowEnd":"2026-10-08"}   -> 201 {id:3}
```

Three rows now cover 2026-10-05: `1 WEEKLY_OFF`, `2 ON_LEAVE`, `3 AVAILABLE` — all with the **same**
`window_start`. Then the exact predicate `currentStatusMany` runs, for `now = 2026-10-05T06:00Z`:

```sql
select id, status from se_availability
where se_id = '459b5409-…' and window_start <= $now
  and (window_end is null or window_end > $now)
order by window_start desc limit 1
```

Run three times. Winner every time: **`id 1, WEEKLY_OFF`**. The manager's clearing write loses.

## Why
`se-availability.service.ts:88-94` orders by `windowStart desc` and keeps the first row per SE, with
the comment `// first = latest windowStart`. There is **no tie-break**. On a tie Postgres returns
rows in physical order, so the *oldest* row wins — deterministically, in practice, forever. The
single-SE reader `currentStatus()` at `:60` uses `findFirst` with the same `orderBy` and inherits it.

## Blast radius
`currentStatusMany` is the one definition of "unavailable" the dispatch side consumes —
`recommender.service.ts:1035` and `scheduling/candidate-query.service.ts:122`, dropping at
`candidate-readiness.ts:56`. So an engineer wrongly put on leave for a day stays excluded from the
Recommender for that day, and every screen that reads `availabilityRows` shows the `AVAILABLE` row
sitting at the top of the list as if the correction had taken. The operator is told they fixed it;
the scheduler disagrees; nothing reconciles the two.

Reach 4, crit 5: it needs a duplicate window to trigger, and ENG-G4 shows duplicates are free to
create.

## Fix shape
`orderBy: [{ windowStart: 'desc' }, { id: 'desc' }]` in both `currentStatus` and `currentStatusMany`
makes last-write-wins real and is a two-line change. The durable fix is supersede-on-write: a new
window closes or shadows the ones it overlaps, so the table stops carrying contradictions at all.
Ship the tie-break first — it is what makes the manager's existing control work.
