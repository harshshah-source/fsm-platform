# 346 — Fleet-uptime honesty + monthly cube coverage

**Done 2026-09-03.** Wave 2 of the module-gaps completion plan (`docs/module-gaps/IMPLEMENTATION-PLAN.md`
§4 slice 346), absorbing survey ids **RPT-01, RPT-02, RPT-09**. Red-first. No upstream dependency;
**#365 (SE productivity report) depends on this.**

## What it closes

The Fleet Uptime number on the Reports page was fabricated on most days of most months, and nothing in
the stack disagreed. Three separately reasonable decisions composed into it:

1. `reports.service.ts` answered **`100`** when the uptime window was zero. `(1 − downtime/window)` is
   undefined at a zero denominator, and of every value it could have returned, `100` is the one that
   reads as a *perfect fleet* — the best possible news, indistinguishable from a real month in which
   nothing broke.
2. The report defaults to the **current** month (`reports.controller.ts` → `currentMonth()`).
3. The three cube crons ran at `0 3 1 * *` and computed only the **previous** month.

So for the ~30 days between cron runs, the month the page asked for had no
`device_downtime_summary_monthly` row, which meant a zero window, which meant `100%`. Not an edge
case: it was the first number the page showed, on 30 days out of 31.

The client had no guard either. The 6-month trend `flatMap`ped `fleet.uptimePct` with no
`eligibleDeviceCount` check, so a real trend read **`100, 100, 100, 56.19, 100, 100`** — one real
number in six, drawn as one continuous line. The Reports KPI, the per-zone bars, the zone-breakdown
table and the ZM scorecard's Zone-SLA column were all unguarded. Only the dashboard hero
(`ManagerDashboard.tsx`, `if (r.fleet?.eligibleDeviceCount > 0)`) was — and it guarded the hero
*number* while entering the same unguarded values into the per-zone and per-plant maps beside it.

## The shape of the fix

**Backend, honesty.** `uptimePct(downtime, window)` returns `number | null` and answers `null` at a
zero window. That one helper feeds the fleet total, the zone/company/plant rows **and** the ZM
scorecard's `zoneSlaCompliancePct` (rows and trend points), so all five are now `number | null` in the
service's exported types and in the admin client's mirror of them.

**Backend, coverage.** The `fleet-uptime`, `root-cause` and `zm-performance` crons moved from
`0 3 1 * *` / `15 3 1 * *` / `30 3 1 * *` to `0 3 * * *` / `15 3 * * *` / `30 3 * * *`, and each tick
now recomputes **the previous and the current month** through a single `runGuarded` call.

**The aggregation needed no change** — verified before touching anything, as the plan asked.
`fleet-uptime-aggregation.service.ts` already clamps `windowEnd = min(now, monthEnd)` and floors
`windowSeconds` at `Math.max(0, …)`, so an in-flight month is scored over the time that has actually
elapsed rather than penalised for the future, and a month that has not started yet gets a genuine
zero window (which is now `null`, not `100`).

**Admin.** `fleetUptimeOrGap(report)` in `api/reports.ts` is the single place "does this report carry
an uptime?" is decided — `null` percentage *or* an empty `eligibleDeviceCount`. The KPI renders an em
dash with a `No data for this month` hint and a neutral tone; the per-zone bars omit unmeasured zones;
the zone-breakdown cell was already null-tolerant and now cannot be handed a fabricated number; the ZM
scorecard column renders an em dash and an unmeasured zone is not a candidate for top performer.

## Decisions worth keeping

**1. `null`, not `0`.** A zero denominator is the *absence of a measurement*, not a measurement of
zero. `0` would have been as wrong as `100`, in the opposite direction — inventing a catastrophe
instead of a perfect month — and it would have been worse in one specific way: `0` is a plottable
number, so the trend would have looked like a real collapse rather than a hole.

**2. A gap keeps its place on the axis.** `apiFleetUptimeTrend` now returns one point per month
*always*, with `value: null` for a month that has no data — including a month whose request failed,
which it used to drop. Dropping is not a neutral choice: with six labels for five points the axis
silently relabels itself, and the reader cannot tell which month is missing. `TrendChart`'s
`TrendDatum.value` is therefore `number | null` and `connectNulls={false}` is now explicit — it is
already recharts' default, but a default is not a decision record, and this rendering is the one the
whole slice rests on. This is the distinction the admin test asserts directly, by serialising the
series the chart is handed.

**3. Both months, every day — not "previous on the 1st, current otherwise".** The branch would be
cheaper and is the wrong trade. A tick that is missed, delayed or throws on the 1st — the single
busiest recompute of the month — would leave the previous month permanently short of its last 21
hours, with nothing to notice it and no second chance until the following year. `computeMonth` is
idempotent (delete-and-reinsert per month, upsert per device), so the repeat costs one pass over a
month nobody is writing to and buys a month of self-healing.

**4. Both months go through ONE `runGuarded` call.** The pair is a single unit of work under a single
tick claim (#263), so a second instance cannot interleave and recompute the same month underneath this
one. Two separate ticks would have been two claims and two races.

**5. The dashboard maps drop unmeasured groups rather than carrying `null` into them.**
`ScorecardTable`'s Fleet Uptime column and `CompanyPlantTable`'s `fmtUptime` both already render a
*missing* map entry as an em dash (and `ScorecardTable` already sorts it to the bottom with `?? -1`).
Absence is the shape those two were built to read. Adding `null` as a second way to say the same thing
would have meant two codes for one state, and one of them would eventually be forgotten — so
`measuredUptime()` in `ManagerDashboard.tsx` keeps `Map<string, number>` and simply omits the groups
with no number. That is also what kept this slice out of five dashboard files another slice owns.

**6. The ZM scorecard's leader is chosen from measured zones only.** The old reduce compared
`r.zoneSlaCompliancePct > top.zoneSlaCompliancePct`; with `null` operands JS answers `false`, so it
would have *happened* to skip nulls — and the same expression with the operands the other way round
would have crowned the empty zone. The filter makes it a decision instead of an accident, and with no
measured zone in the range there is no top performer and the card does not render.

## What was tested, and why in that shape

**Two shapes of "no data", not one.** `EMPTY_MONTH` has no summary rows at all; `ZERO_WINDOW_MONTH`
has eligible devices, real rows, and a window of zero seconds — what `computeMonth` writes for a month
that has not started. They are not the same case and they used to produce the same fabricated `100`.
The second is the one that reads most convincingly as real, because the device count beside it is
genuine. Both use months (`2029-11`, `2029-12`, `2029-10`) that nothing in the tree computes, for the
same isolation reason `fleet-uptime-report.e2e-spec.ts` already pins March.

**The trend assertion is made on the series, not the pixels.** `TrendChart` is a recharts surface with
no measurable box in jsdom, so the admin test stubs it and serialises the `data` prop. That is the
only way to tell a gap from a plotted zero, and telling those apart is the point of the slice — the
test asserts the label is present, the value is `null`, and the series contains neither `0` nor `100`.

**AC3 is two independent bindings, asserted separately.** The cron has to fire every day *and* the
tick has to compute both months; either can regress without the other. The cadence is read off
`SchedulerRegistry` — what actually schedules the work — rather than off the default constant, which
would pass vacuously if the decorator stopped reading it. The month arithmetic is asserted by driving
the container's own scheduler with spied aggregation services.

**AC5 (recompute unchanged) is asserted, not assumed**, because the honesty change is in a helper the
recompute path does not use, and "unchanged" claims that nobody re-reads are how this defect class
survives.

## Acceptance criteria

- **AC1** — met. `uptimePct` → `null` at a zero window, at fleet **and** row level, at every grouping;
  `eligibleDeviceCount` stays a real count (it is not zeroed to signal absence).
  `fleet-uptime-report.e2e-spec.ts` (3 new cases) + `reports-controller.e2e-spec.ts` over the wire.
- **AC2** — met. `apiFleetUptimeTrend` emits `value: null` for an empty (or failed) month, keeps the
  label, and `ReportsPage` renders the empty state when no month has a number. Asserted on the
  serialised series in `apps/admin/test/fleet-uptime-honesty.test.tsx`.
- **AC3** — met. The three cube crons are daily and each tick computes previous **and** current month.
  `scheduler-wiring.e2e-spec.ts` (registry cadence + the calls).
- **AC4** — met. `reports-controller.e2e-spec.ts`: `GET /api/reports/fleet-uptime?month=2029-10`
  returns `uptimePct: null`, `eligibleDeviceCount: 0`, `rows: []` — the key is present and null, not
  absent.
- **AC5** — met. `POST /api/reports/fleet-uptime/recompute` still 200s with `{ month, devices }`.

## Tests, verbatim

New/edited backend: `test/fleet-uptime-report.e2e-spec.ts` (+3), `test/reports-controller.e2e-spec.ts`
(+2), `test/scheduler-wiring.e2e-spec.ts` (+2) — **7 new cases, all red first**
(`3 failed files / 7 failed | 11 passed` before the fix).

New admin: `apps/admin/test/fleet-uptime-honesty.test.tsx` — **12 cases**, red first
(`8 failed | 4 passed` before the fix).

One assertion in a file this slice does not own had to move:
`test/cron-tick-claim-wiring.e2e-spec.ts` asserted `computeMonth` was called **once** per fleet-uptime
tick. It is two now (previous + current) under the same single claim, which is what that case is
actually about. One number, with the reason beside it.

**Backend, green run (through `.scratch/locks/backend-test.sh`).** Eight files covering every consumer
of the two changed helpers — `fleet-uptime-report`, `reports-controller`, `scheduler-wiring`,
`business-sweep-scheduler`, `business-sweep-scheduler-wiring`, `cron-tick-claim-wiring`,
`zm-scorecard-report`, `fleet-uptime-aggregation`: **7 files / 48 tests passed**, with
`reports-controller.e2e-spec.ts` re-run on its own → **7 / 7 passed**. Its first pass in the batch hit
a 10 s `beforeAll` bootstrap timeout under load, not an assertion. An earlier batch showed the
`401 Unauthorized`-at-login pattern across files — the documented symptom of a second suite truncating
the shared `fsm_test` database, not a regression.

**Admin, full suite: 128 files / 927 tests → 924 passed.** The three failures are outside this slice
and were confirmed so: `issue-122b-ui` fails on an "Action Required" heading another live slice is
adding to the dashboard, and `activity-trend-section` / `ticket-detail-drawer` pass in isolation
(parallel-worker interference). This slice's own files —
`fleet-uptime-honesty`, `reports`, `zm-scorecard`, `dashboard-company-plant`,
`company-plant-overview-rework`, `commissioning-cohort` — are **55 / 55 green**, which is the set that
would have caught a regression in the two uptime maps and in `TrendChart`'s widened datum.

Typecheck: `npx tsc --noEmit` (backend) and `npx tsc -b` (admin) → exit 0.

## Follow-ups this slice does not own

- **`ManagerDashboard.tsx`'s hero still gates on `eligibleDeviceCount > 0` before reading the
  percentage.** That is now belt-and-braces rather than the guard (the value itself is `null`), and it
  is correct as it stands; simplifying it belongs to whoever next owns that file (slice 351). Note
  this slice's `measuredUptime()` edit to that file was swept into commit `f29725e` (#350), which
  committed the same file for its own reasons while this slice was in flight — the change is in HEAD,
  not in this slice's diff.
- **`ZmScorecardReport.trend` is still `unknown[]` on the admin client**, so the scorecard's trend
  points' new `zoneSlaCompliancePct: number | null` is not yet visible to the UI. Slice **364** owns
  typing and drawing that trend; when it does, the gap rendering must match the Reports trend.
- **`RootCauseAnalyticsPage` / `SystemEfficiencyPage` freshness** — slice **347** adds `dataAsOf` to
  every cube payload. With the cubes now recomputed daily, "Data as of" finally has a moving value to
  report; today the page still prints the client clock.
