# ENG-G2 — planner intent bends dispatch, unattributably (walk, 2026-09-02, E4)

**Outcome: confirm.** The effect is auditable; the cause is not.

## The walk
```
POST /planner {"seId":"459b5409…","plantId":"1","plannedDate":"2026-10-05"}  -> 201 {id:6}
   audit_logs delta: ZERO rows
DELETE /planner/6            as zm.south -> 403 ZONE_SCOPE_VIOLATION
DELETE /planner/6            as zm.north -> 200 {deleted:true}
   audit_logs delta: ZERO rows;  se_planner row 6 HARD-DELETED, count = 0
```

## Where the asymmetry bites
`se_planner` carries `created_by` (`schema.prisma:767`), so a *surviving* row names its author.
Deletion carries nothing: `SePlannerController.remove` (`:70-82`) never threads an actor at all —
`SePlannerService.remove` takes only `(id, scope)` — and the row is physically removed. A planner
cell that biased yesterday's run and was quietly pulled this morning is unrecoverable: no row, no
audit entry, no name, no time.

That matters because of what a planner row does. `recommender.service.ts:529` loads
`plannerForDate(zoneId, targetDay)` and `:646` applies the ADR-0022 soft bias — among eligible
candidates it prefers the planner-named SE over the top-scored one — and `:862` stamps
`plannerBias: plannerPlannedChosen && passed[0]?.seId !== chosen.seId` onto the decision trace.
So the trace tells a reviewer "this assignment was overridden by a planner intent" and there is no
way to find out **whose** intent, or whether it still exists.

## The alternative, refuted at E2 (do not price a "planner keying is broken" fix)
ENG-H2's strongest alternative was that the admin grid and the Recommender normalise the date
differently, leaving `plannerForDate` matching nothing. They do not:
`se_planner.plannedDate` is `@db.Date` (`schema.prisma:766`); `recommender.service.ts:314` builds
`targetDay` with `istDate()`, which `common/ist-day.ts` documents as "the `@db.Date` form"; and
`plannerForDate` (`:1130-1132`) equality-matches on that. The write I made through the API landed on
the IST calendar day I asked for. The join is sound at the type level.

## What is still NOT proven
Whether the bias actually flips a choice at run time. `plannerBias` was not observed on a live trace —
that needs a dispatch run, which mutates the shared board and was out of scope for this walk.
Cost to settle: seed one planner cell for **today's** IST date on a plant with an open ticket, run
`POST /schedules/dispatch-run` for that zone, read `plannerBias` on the decision trace. Recorded in
`not-walked.json`.

## Fix shape
Audit both writes. `upsert` already receives an actor — record `PLANNER_ENTRY_SET`. `remove` must
first be given one (controller + service signature), then record `PLANNER_ENTRY_REMOVED` with the
seId/plantId/date the row held, since the row itself will be gone.
