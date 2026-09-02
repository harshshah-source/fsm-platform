# ENG-G4 — leave windows stack, and nothing notices (walk, 2026-09-02, E4)

**Outcome: confirm.** Severity raised **S2 → S3** and `dangerous` false → true, because of what the
stacking does downstream (ENG-G6).

## The walk
One engineer, Sumit Chopra `459b5409` (zone 1). Three leave requests, all overlapping:

| id | type | window (IST) | result |
|---|---|---|---|
| 1 | ON_LEAVE | 2026-10-05 → 10-06 | 201, PENDING |
| 2 | WEEKLY_OFF | 2026-10-05 → 10-07 | 201, PENDING |
| 3 | ON_LEAVE | 2026-10-05 → 10-06 | 201, PENDING |

No warning, no 409, no dedup. Re-`GET /leave-requests` (check 3) returned all three. Request 1 was
rejected; 2 and 3 were approved, and each approval minted its own `se_availability` row:

```
id 1  WEEKLY_OFF  window_start 2026-10-04T18:30Z  window_end 2026-10-07T18:30Z
id 2  ON_LEAVE    window_start 2026-10-04T18:30Z  window_end 2026-10-06T18:30Z
```

Note the `window_start` values are **identical** — both requests named the same IST calendar day, and
`istWindowStart` maps a bare date to IST midnight. That tie is what turns a tidy-looking duplicate
into a correctness problem (ENG-G6).

## Why nothing stops it
`LeaveRequestService.submit` (`:61-77`) checks two things: the engineer exists, and the actor may act
for them. It then `create`s unconditionally. `schema.prisma:1514-1515` carries `@@index([seId,
createdAt])` and `@@index([status])` — no `@@unique`, no Postgres exclusion constraint on the range.
The controller's validation (`leave-request.controller.ts:48-65`) checks the *shape* of one window,
never its relation to any other.

## Two more things the walk found
- **An approved leave is terminal with no undo.** The controller has `submit`, `list`, `approve`,
  `reject` and nothing else — no cancel, no withdraw, no re-open. The only escape is to write a
  clearing `AVAILABLE` availability row, and ENG-G6 shows that does not work.
- **The overlap is not even type-consistent.** Rows 1 and 2 say the same engineer is simultaneously
  `WEEKLY_OFF` (through Oct 7) and `ON_LEAVE` (through Oct 6). Both are "unavailable", so the
  Recommender's behaviour happens to be the same today — but any reporting that counts leave days,
  or any future rule that treats weekly-off differently from leave, reads a contradiction.

## Fix shape
Reject an overlapping window at `submit` for the same `seId` (a PENDING or APPROVED row whose range
intersects), plus a DB-level exclusion constraint so a concurrent pair cannot slip past the check.
The overlap guard alone does **not** repair rows already stacked — that is ENG-G6's job.
