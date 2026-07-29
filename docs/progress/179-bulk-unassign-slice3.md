# 179 — OH bulk unassign, Slice 3 (hollow-stop read filter)

TDD completion report. Frozen once written — corrections go to INDEX/SYSTEM-STATE, not here.

## AC-by-AC

- **SE day-plan read no longer renders zero-ticket stops** — `DayPlanQueryService.getDayPlan`
  (`day-plan-query.service.ts`) filters `batches` to `tickets.length > 0` before mapping to `stops`,
  right before the existing map. A batch every one of whose tickets has `removed_at` set (by a bulk
  unassign or a ZM override) is dropped entirely rather than rendered at `deviceCount: 0`.
- **ZM schedule detail read no longer renders zero-ticket stops** — same filter,
  `ZmScheduleQueryService.getScheduleDetail` (`zm-schedule-query.service.ts`).
- **Deliberately not touched:** `ZmScheduleQueryService.listSchedules` — its `batchCount` is a
  per-SE summary count, not a stops render; the issue names "the SE day-plan read... and the ZM
  schedule views that render stops" specifically. Widening the filter there would be scope beyond
  what Slice 3 asked for.
- **File-coordination discipline held**: `day-plan-query.service.ts` is shared with #147
  (date-filter/closure) and #165 (poll bounding/`planVersion`). Only the one filter line was added;
  no date predicate, no version field, no closure logic touched.

## RED → GREEN

1. `test/day-plan-query.e2e-spec.ts` — new test built a fully self-contained fixture (its own SE,
   two plants, one ticket per plant) inside a real dispatched schedule, then stamped one plant's
   ticket `removed_at`/`removed_by` — the exact mutation `BulkUnassignService.execute` and
   `OverrideService.removeTicket` make. RED: `expected [...] to have a length of 1 but got 2` (the
   hollow stop rendered). GREEN: the one-line filter.
2. `test/zm-schedule-query.e2e-spec.ts` — identical shape against `getScheduleDetail`. RED: same
   failure mode. GREEN: the same filter, applied there.

Both tests wrap their body in `try/finally` so an assertion failure still cleans up the fixture's
schedule/batch/ticket/plant rows — caught during the first RED run, before it could leave the
shared `fsm_test` DB in a state that broke the next test's `afterAll`.

## Tests / typecheck

- Extended (not modified elsewhere): `test/day-plan-query.e2e-spec.ts` (+1 test, existing 2
  unchanged), `test/zm-schedule-query.e2e-spec.ts` (+1 test, existing 4 unchanged).
- Touched-neighbourhood regression: `day-plan-query`, `zm-schedule-query`,
  `zm-schedules-controller`, `schedules-controller`, `override-schedule-live`,
  `override-defer-leaves-today`, `dispatch-same-day-append`, `zone-engineers`,
  `dispatch-zone-wedge` — 9 files / 40 tests green.
- `npx tsc --noEmit -p .`: clean.

## REFACTOR

None.

## Remaining work

- **Slice 4** — OH-only admin page (Plant Deactivations pattern): two buttons, preview modal with
  class counts, typed confirmation, `audit_logs`-backed history.
