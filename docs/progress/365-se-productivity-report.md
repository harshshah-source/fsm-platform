# 365 — SE productivity report

**Done 2026-09-04.** Wave 5 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey id RPT-05. Red-first. The design stop
was cleared by the operator on 2026-09-03 — decision record
`.scratch/fsm-platform-v1/issues/368-decision-se-productivity-report.md`, approved design
`docs/ui/desktop/approved-designs/se-productivity-report.html` (`21-reports.png` governs the chrome).

## What it closes

The PRD has named an SE productivity report since the beginning (`:33`, `:340`, story 25) and there was
no route, no endpoint and no page. There is now one of each: `GET /api/reports/se-productivity`,
`/reports/se-productivity`, and an Analytics nav entry beside System Efficiency — the fleet-wide
version of the same pipeline.

But the prerequisite mattered more than the page, and it is the part worth reading:

**Audit finding F7 — `se_repaired_closures` counted closures nobody earned.** The Fleet Uptime
aggregation counted every TROUBLESHOOT ticket in `status = 'CLOSED'` as an SE repair. Three different
writers put a troubleshoot ticket into `CLOSED`, and only one of them is an engineer repairing a
device:

| writer | `closure_type` | what happened |
| --- | --- | --- |
| `VerificationService.finalize` | `NULL` | the SE submitted a form, the device came back, the cycle verified |
| `DeviceDepartureService` | `DEVICE_UNDEPLOYED_CLOSE` | the vehicle left the fleet; the master sync closed the ticket |
| `PlantDeactivationService` | `OPERATIONS_HEAD_OVERRIDE_CLOSE` | the plant was deactivated |

So an engineer whose plants happened to lose vehicles read as **more productive** than one who
repaired devices, in the column whose name asserts the opposite. The regression test constructs the
exact shape: two repairs, three departures, one plant deactivation, one auto-recovery. Before the fix
the report answered **6**; it now answers **2** (verified red — see *Tests, verbatim*).

Building the page on the unsplit column would have published that mis-attribution to precisely the
people who make staffing decisions. That is why Repair and Departure are separate columns in the
approved design rather than a nicety, and why the split landed first.

## Where the issue's premise was wrong

**The `se_id` dimension of `system_efficiency_summary_daily` cannot serve this report, and the plan and
the issue file both assume it can.** Both name it as the raw material (`plan §4`, issue *Problem*).
Checked against `system-efficiency-aggregation.service.ts`: the cube has eleven insert legs, and
`se_id` is populated by **legs 5 and 7 only** — auto-assignments (via the Recommendation's SE) and
batch overrides. Every leg this report needs writes `se_id = NULL`:

- leg 3 — cycles resolved, **first-time fixes**, SLA compliance → `se_id NULL`
- leg 4 — **failed verifications**, auto-recoveries → `se_id NULL`
- leg 8 — **on-site → submission** stage times → `se_id NULL`

and **no cube anywhere carries a closure-type split**, which is what the Repair/Departure columns need.
Of the four summary tables (`device_downtime_summary_monthly`, `root_cause_summary_monthly`,
`zm_performance_summary_monthly`, `system_efficiency_summary_daily`), the two that carry `se_id` carry
none of the four AC1 metrics at that grain.

**Consequence, and the decision taken.** Serving this from a cube needs new columns —
`schema.prisma` is owned by #366 in this round and may not be touched. The read is therefore a bounded
live query over `tickets` / `failure_cycles` / `verification_runs` / `troubleshooting_submissions` /
`soft_states`, following the pattern `workTypeMix` and `verificationOutcomes` already establish in the
same service, with the honest `dataAsOf` #347 gives those two (the instant the server answered, never a
fabricated cube stamp). **This is a stated deviation from the approved design's "no live
recomputation"**, taken rather than shipping nothing in the last round of the backlog; the follow-up
that would restore the cube path is in *Follow-ups* below. The design's actual concern — disagreeing
with the ZM scorecard beside it — is addressed where it bites: the first-time-fix predicate is
character-for-character leg 3's (`state = 'VERIFIED' AND NOT repeat_failure AND
sla_accumulated_pause_seconds = 0`), so the per-SE rate and the fleet rate are one measure at two
grains rather than two definitions that quietly disagree. The window is one week or one month of one
zone's tickets — nothing like the multi-year telemetry scans the cubes exist to prevent.

## Decisions worth keeping

**1. The small-sample floor is ten closures, and it is enforced on the server.** Below it every rate
comes back `null`. The obvious place for suppression is the renderer, and it is the wrong one: a rate
the payload still carries is one CSV export away from being acted on, and the number is noise either
way. Ten is where a single outcome stops being able to swing a rate by more than ten points. **Counts
are never suppressed** — six closures is a true fact about six jobs, and hiding it would conceal the
one thing about a low-volume engineer a manager should see. The threshold travels in the payload
(`rateMinSample`) so the footer states it rather than the page hard-coding a number that could drift
from the server's.

**2. `null` means two different things and the row says which.** `ratesSuppressed` separates "withheld
because the sample is too small" from "no denominator in the window". Both render as an em dash, and
they are not the same fact — the cell's `data-withheld` attribute and its title carry the difference.
Neither is ever formatted as `0%`, which would read as a measured failure.

**3. One attribution rule for the whole row.** The engineer who *did the work* (the latest
`troubleshooting_submissions.se_id`), falling back to the engineer the ticket was last assigned to (via
`batch_assignment_tickets` → `plant_batch_assignments`). Two rules would let the Repair and Departure
counts on one row describe two different people. The fallback is not decoration: it is the **only**
attribution a departure closure can have, because nobody submitted a form. Without it the Departure
column would be empty, which is F7's information loss with the opposite sign.

**4. The roster is the row set, not the activity.** Every active engineer in scope gets a row,
including one who closed nothing. The page answers "which of my engineers needs attention"; an
engineer who did no work this month is an answer to that question, and joining on activity would make
the emptiest case invisible.

**5. Out-of-band marking uses fixed operational bands, never percentiles of the visible cohort.** The
design forbids ranking, so "flag the worst two rows" is exactly what must not be built — it always
flags somebody, including in a zone where everyone is fine, and it moves a person's marking when a
*colleague's* month changes. A fixed band flags a number against what the operation expects of it,
which is what makes the mark answerable: "why is this one 57%?" has an answer, "why is this one in the
bottom two?" does not. Bands live in one exported constant (`SE_PRODUCTIVITY_BANDS`): first-time fix
amber <65 / crimson <50, failed verification amber >8 / crimson >12, on-site→submit amber >1h 40m /
crimson >3h.

**6. Nothing is pre-sorted worst-first.** The server orders by name; the table is sortable and opens
unsorted. A withheld rate sorts as `-1` rather than `0`, so sorting cannot rank a six-closure engineer
as the worst in the zone on a number the page refuses to show.

**7. Weekly is anchored by any day in the week.** `weekOf=2026-06-17` (a Wednesday) resolves to the
Monday–Sunday week 15–21 June. A caller never has to know which day a week starts on, and a shared
link to "the week of the 17th" is stable whichever day of it was clicked.

## What was tested, and why in that shape

The F7 pin runs the **aggregation**, not a seeded cube row: the defect is in the attribution, so
seeding `se_repaired_closures` directly would pin nothing. It lives in `fleet-uptime-report.e2e-spec.ts`
(as briefed) with its own month (August 2027) and its own device, because `computeMonth` is a global
delete+insert per month and must not touch the March rows the rest of that suite counts — the same
isolation rule the file's own header already documents.

The endpoint spec seeds a zone of four engineers whose numbers are chosen so each constraint fails
loudly if broken: 15 closures (above the floor, rates shown), 6 closures (below it, rates withheld,
counts kept), 0 closures (on the roster anyway), and one in a second zone (the clamp's target). Names
are `A…`/`B…`/`C…` so asserting the row order **is** asserting that the server does not rank. Every
fixture instant is inside June 2026, so nothing depends on the wall clock, and a May and a July closure
sit outside the window to pin the boundary.

## Acceptance criteria

- **AC1 — per-SE closures by type, first-time-fix rate, failed-verification rate, and average on-site →
  submission time; weekly and monthly; zone clamped for ZM.** Met. Closures split Repair /
  Departure by `closure_type` (F7); the three derived measures as above; `granularity=monthly|weekly`
  with a month or week anchor; a ZM is clamped server-side and the clamped zone is echoed in
  `filters.zoneId` so the page's scope chip states the zone actually read. **"Computed from the summary
  tables" is the one clause not met** — see *Where the issue's premise was wrong*; the summary tables
  do not carry the data, and the deviation is recorded rather than silently taken.

## Tests, verbatim

**Red first** — the F7 predicate reverted to the pre-fix `ELSE 'SE_REPAIR'`:

```
FAIL test/fleet-uptime-report.e2e-spec.ts > … > F7 — se_repaired_closures counts repairs only, never departures
  > the report the dashboard reads carries the split, not the inflated figure
AssertionError: expected 6 to be 2 // Object.is equality
 Test Files  1 failed (1)
      Tests  2 failed | 7 passed (9)
```

Green, backend (through `.scratch/locks/backend-test.sh`):

```
 ✓ test/se-productivity-report.e2e-spec.ts (12 tests) 708ms
 ✓ test/fleet-uptime-report.e2e-spec.ts (9 tests) 549ms
 ✓ test/fleet-uptime-aggregation.e2e-spec.ts (6 tests) 585ms

 Test Files  3 passed (3)
      Tests  27 passed (27)
```

`test/system-efficiency-report.e2e-spec.ts` also re-run green (the neighbour whose first-time-fix
definition this report reuses).

Green, admin:

```
 ✓ test/se-productivity.test.tsx (11 tests) 480ms
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

No regression in the sibling report surfaces or the nav:

```
 Test Files  6 passed (6)
      Tests  45 passed (45)
```

(`reports.test.tsx`, `report-filters.test.tsx`, `report-freshness.test.ts`, `system-efficiency.test.tsx`,
`help-center.test.tsx`, `dispatch-timeline-nav.test.tsx`.)

Typecheck: `apps/admin` `tsc -b` clean; `apps/backend` `tsc --noEmit` reports no error under
`src/reports/`.

**One spec could not be run green, and it is not this slice's.**
`test/reports-controller.e2e-spec.ts` boots the whole `AppModule` and currently fails at bootstrap with
`Nest can't resolve dependencies of the InventoryService (PrismaService, ?) … NotificationService … in
the RecommenderModule context` — #361's notification-adoption wiring, half-applied in the shared tree
while this slice ran. It is unrelated to the reports module (no constructor of ours changed) and will
pass once #361 finishes its module wiring; the orchestrator's full-suite run is the check.

## Follow-ups this slice does not own

1. **A per-SE cube, so the report can stop reading source tables.** The cheapest honest shape is to
   populate `se_id` on legs 3, 4 and 8 of `system-efficiency-aggregation.service.ts` — which needs *no*
   schema change, since finer grouping preserves every existing SUM — plus two new columns on
   `system_efficiency_summary_daily` for the repair/departure closure split, which does. Blocked here
   only by #366 owning `schema.prisma` this round. Until then this page is a live read and says so.
2. **A `departure_closures` column on `device_downtime_summary_monthly`.** F7 is now correct by
   *exclusion* — departures no longer inflate `se_repaired_closures` — but the count itself is not
   stored, so the Fleet Uptime report cannot show "and this many closed because vehicles left". The
   aggregation already classifies all four `ClosureKind`s, so the column is the only missing piece.
3. **A per-SE second screen, reached by clicking a row.** Decision #368 explicitly calls the scorecard
   "a reasonable second screen later" and the wrong *first* one. Rows are not clickable today.
4. **`OPERATIONS_HEAD_OVERRIDE_CLOSE` closures are visible nowhere.** The aggregation classifies them
   as `ADMINISTRATIVE` and the report counts neither them nor them as departures, so a plant
   deactivation's closures simply do not appear on either surface. Correct — they are not repairs and
   not departures — but somebody should decide whether a third column is owed.
