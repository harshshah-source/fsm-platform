# 364 — Report pages consume what the API already offers

**Done 2026-09-03.** Wave 4 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids RPT-04, RPT-06, RPT-07 and
RPT-08 (re-typed per §1 to a hub card). Red-first — 14 of 15 assertions in the new
`report-filters.test.tsx` were observed failing against surfaces that did not exist. Built on **#347**
(commit `ddc2e05`), which created the reference header band this slice's controls sit inside.
**The backend is unchanged by this slice.**

## What it closes

Four defects that share one property: **the platform already had the answer and the screen would not
ask for it.**

**1. Five filterable endpoints, called bare.** `/reports/root-cause`, `/reports/efficiency`,
`/reports/zm-scorecard`, `/reports/work-type-mix` and `/reports/verification-outcomes` have accepted
from / to / zone / company / plant / deviceType / SE since Issues 41–43 and 90
(`reports.controller.ts:149-257`). Every client called them with no parameters at all
(`api/reports.ts:120-201`). A manager who wanted last month, or one zone, or one device type could not
ask: they read the default window and did the arithmetic in their head, or they exported and filtered
in Excel — which is where reporting stops being the system's answer and becomes someone's spreadsheet.

**2. A computed series the client threw away.** `zmScorecard` builds a per-ZM monthly `trend[]`
(`reports.service.ts:515-548`) and the client typed it `unknown[]` (`api/reports.ts:199`). Nothing
could consume it without an assertion, so nothing did. The scorecard **ranks people** on a single
aggregate; without the trend it cannot tell a ZM whose override rate is high and *falling* from one
whose is high and *climbing*, and only one of those is a problem to act on.

**3. No number linked to its rows.** A figure that looks wrong could not be interrogated without
rebuilding the filter by hand on another page.

**4. The finance voucher export was hidden behind the review queue.** `GET /vouchers/export?month=`
has existed since Issue 59/60 and lived only on the Vouchers page. The Operations Head who runs the
monthly finance pull is not reviewing vouchers; they are on the Exports hub, which showed one card and
gave no hint the export existed. Per §1 correction **RPT-08 this is a hub card, not an integration** —
the export itself is built.

## Where the issue's premise was wrong

Two of the three link targets the plan named **do not exist**, and both were verified in current code
rather than assumed:

| plan said | reality | what was built |
|---|---|---|
| zone row → `/reports/fleet?zone=` | `FleetDirectoryPage.tsx:40-41` reads **only** `tab` and `companyId`. A `zone` param is ignored, so the link would land on the unfiltered directory. | zone rows → `/reports/device?zoneId=…`, which `DeviceDetailPage.tsx:83` genuinely reads (plus `&status=INACTIVE` on the Reports landing, `:65`). |
| root-cause row → `/tickets?rootCause=` | `GET /tickets` takes status / workType / companyId / plantId / plant / q / assignmentState / bucket / special and has **no** `rootCause` parameter (`ticketing/tickets.controller.ts:46-56`). Ops Explorer has no troubleshoot-submission dataset either — its eleven datasets are devices, zones, companies, plants, vehicles, engineers, tickets, batches, dispatchRuns, recommendations, auditLogs. | **No link, deliberately** — see the AC3 note below. The page says what is missing instead. |
| SE row → `/engineers/:id` | The scorecard's rows are **Zonal Managers**, not engineers; there is no per-SE report table on these four pages (that is #365, W5). | ZM rows → `/reports/system-efficiency?zoneId=…&from=…&to=…` — the per-zone decision activity behind the override and manual-assignment counts, over the same range. |

Also corrected: **`device_type` has no option source anywhere in the tree.** It is a free-form
`String` column (`schema.prisma:1729, 2061, 2732, 2794`) with no enum, no catalogue table, and
`/devices/filter-options` returns zones, companies and plants only. So the device-type control is a
debounced text box, not a dropdown — a hard-coded list would be a control that silently cannot reach
half the fleet.

## The shape of the fix

**`api/reports.ts`.** `ReportFilterParams` plus one `reportQuery(params, fields)` builder, and a
`REPORT_FILTER_FIELDS` table transcribed from the controller saying which dimensions each endpoint
actually reads. `ZmScorecardTrendPoint` / `ZmScorecardSeries` replace `unknown[]`, mirroring
`reports.service.ts`.

**`pages/reports/ReportFilterBar.tsx`** (new, co-located exactly as #347 co-located
`DataAsOfStamp.tsx`): `useReportFilters` (URL-backed state), `useReportFilterOptions` (the dropdown
sources), `ReportFilterBar` (the controls) and `ReportScope` (the echo-driven chip).

**`DataAsOfStamp.tsx`** gains **one optional prop** — `filters?: ReactNode`, a second line inside the
same band. Purely additive; every existing caller renders byte-identically. This is the one file
outside the slice's declared list, and it is the shared leaf the brief's exception covers: the filter
bar was required to go *into* #347's band, and #347's `ReportMetaStrip` had no slot for a second row.

**The four pages** wire the bar into the band, refetch on filter change, and link their zone-keyed
rows. **`ExportsPage.tsx`** gains the finance voucher batch card.

## Decisions worth keeping

**The scope chip renders the server's echo, never the local pick.** This is the half of AC1 that is
not obvious and the reason the AC says "echoed back" rather than "sent". `reports.service.ts` pins a
Zonal Manager to their own zone whatever was asked for —
`restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : (opts.zoneId ?? null)` at `:437`,
`:628` and `:690` — and echoes the **clamped** value back in `filters.zoneId`. A chip drawn from the
dropdown would therefore tell a ZM who picked North that they were reading North while every number
under it was West's. That is not a cosmetic slip: nothing on the page would look wrong. So the chip
reads the answer, carries `data-clamped`, and when the two disagree it says so in words — a control
that quietly ignores input teaches people to distrust all of them.

**Filter state lives in the URL, not `useState`.** A filtered report is a thing people send each
other; "look at North for June" is a link or it is a paragraph of instructions. It is also what makes
a row link into another report land *filtered* — the scorecard's drill-down carries its range because
`SystemEfficiencyPage` reads the same query keys. It costs nothing now and cannot be retrofitted later
without touching every control.

**A page offers only the dimensions its endpoint reads**, from `REPORT_FILTER_FIELDS`. A control whose
parameter the endpoint ignores is worse than a missing control: it returns the *unfiltered* number
under a filtered-looking UI, and nothing on screen says so. This is why the two live distributions get
zone/company/plant and no device type or SE — they aggregate `tickets` and `verification_runs`
directly, not a cube carrying those dimensions.

**The Reports landing gets ONE month picker, not a range.** It is the only page with two granularities
under one control: `/reports/fleet-uptime` — the hero KPI, the per-zone bars and the breakdown's
uptime column — is single-month by construction, while the two distributions take a day range. A
from/to pair would have to be silently collapsed to a month for the KPI, so the reader would set a
range and get an answer over a different window. One month, expanded to its first and last day for the
distributions, is the only shape where every number on the page covers the window named at the top of
it.

**The range granularity is the page's, not the builder's.** `/reports/root-cause` and
`/reports/zm-scorecard` parse `YYYY-MM`; `/reports/efficiency` and the two distributions parse
`YYYY-MM-DD`. The wrong granularity is a 400, not a coerced value, so the control renders `type=month`
or `type=date` from a `granularity` prop rather than guessing from the string.

**The trend's metric switch is client-side.** The whole series for every ZM already arrives with the
report; re-asking the server for a column it just sent is a round trip that can only return the same
numbers. Pinned by a test that counts requests across a metric change.

**The voucher row count is derived from the APPROVED queue, and no backend endpoint was added.** The
export's own predicate is `status = 'APPROVED' AND submitted_at ∈ month`
(`vouchers.service.ts:475-479`), and `GET /vouchers?status=APPROVED` returns exactly that population,
unpaged, for the Operations Head. Counting it in the client means the number on the card and the rows
in the file are **one predicate evaluated once**. The optional `exports.controller.ts` summary the
plan allowed would have been a second implementation of the same predicate, free to drift — and a
batch count that disagrees with the batch is worse than no count. It would also have needed
`VouchersService` injected into `ExportsModule`, which is a file #359 is working in this round.

**Every option list is shape-checked before it reaches state.** `.catch` does not cover a bad shape:
the request *succeeded*, and the `undefined.map` is then thrown from inside a React state updater
during render, which takes the whole report page down rather than just the dropdown. This is exactly
Round 2's one regression, and it was reproduced here by a pre-existing fixture answering `json({})` to
every unmatched URL.

**No role chip.** Refs 21/23/24/25 draw one beside the stamp (`ZONAL MANAGER`, `OPERATIONS HEAD`).
Reading it needs `useAuth()`, which throws outside `AuthProvider`, and the four report pages are
rendered bare by five existing test files. The role is already displayed persistently in the TopBar
(top-right of every reference shot), so the chip restates it; the scope chip — the one that carries
operational meaning, and the clamp — is built. Recorded here rather than deferred silently.

## What was tested, and why in that shape

**The two halves of the round trip are asserted separately, because only one was ever in doubt.**
Sending `zoneId=2` is trivially observable in the request URL. What matters is what the page then
*shows*: the discriminating test asks for zone 2, has the server answer `filters.zoneId: 1`, and
asserts the chip reads **West** and not North, with `data-clamped="true"`. Its mirror asserts an
unclamped viewer's pick survives with `data-clamped="false"`, so the marker cannot be a constant.

**The trend is asserted through its text alternative, not the SVG.** `test/setup.ts` stubs
`ResizeObserver`, so recharts measures 0×0 under jsdom and draws nothing — the axis labels are simply
not in the DOM. The panel therefore renders an `sr-only` table of the same series, which is the
accessible rendering a chart needs anyway, and the test reads that. `data-series` / `data-metric` on
the panel pin the selection, because both ZM names are always present in the `<select>`'s options and
asserting on text would pass without the selection changing at all.

**One test proves the *absence* of parameters.** With nothing picked, the first request must be the
bare `/reports/root-cause` — otherwise a filter bar that defaults its own window would silently
override each endpoint's documented default and change every number on first load.

## Acceptance criteria

- **AC1 — every filter round-trips to the API and the ZM clamp is echoed back.** ✅ Month range,
  day range, zone, company, plant, device type and SE all reach the request on the pages whose
  endpoints read them; the scope chip renders the server's echoed `filters.zoneId` and marks a clamp.
- **AC2 — the scorecard trend is drawn.** ✅ `ZmScorecardSeries` replaces `unknown[]`; the panel draws
  the selected ZM's monthly series over four switchable metrics, with `null` months as gaps.
- **AC3 — each report table row links to a filtered source list.** ✅ **on three of the four tables**
  — Reports landing zone rows → `/reports/device?zoneId=…&status=INACTIVE`, System Efficiency zone
  rows → `/reports/device?zoneId=…`, ZM Scorecard rows → `/reports/system-efficiency?zoneId=…&from=…&to=…`.
  ⚠️ **The Root Cause breakdown has no link, deliberately.** Its rows are troubleshoot submissions in
  a category and **nothing in this repo lists them** — `/tickets` has no `rootCause` parameter and Ops
  Explorer has no submissions dataset (both verified above). A link to a list that ignores the filter
  shows the reader a *different population* under the number they clicked, which is worse than no
  link. The page states the gap in place of the link. Closing it is a backend change
  (`root_cause_category` on the ticket query) that this slice is not licensed to make; filed as a
  follow-up below.
- **AC4 — the Exports hub shows the voucher batch card with the row count for the month.** ✅ Month
  picker, approved-voucher count and batch total for that month, download through the existing
  `GET /vouchers/export?month=`, and a disabled button with a stated reason for an empty month.

## Tests, verbatim

`apps/admin/test/report-filters.test.tsx` — **new, 15 tests**

```
✓ #364 AC1 — every filter round-trips to the API (6)
  ✓ Root Cause: the month range, company, plant, device type and SE all reach the request
  ✓ Root Cause: the date range is sent as YYYY-MM months, the granularity that endpoint parses
  ✓ System Efficiency: the date range is sent as YYYY-MM-DD days, with every dimension
  ✓ Reports landing: the month drives fleet uptime and the day range of both distributions
  ✓ ZM Scorecard: the month range and the zone drill-down reach the request
  ✓ sends no filter params at all when nothing is picked, so each endpoint keeps its own default window
✓ #364 AC1 — the ZM clamp is echoed, not assumed (3)
  ✓ Root Cause: renders the zone the server answered with, and marks it clamped
  ✓ System Efficiency: an unclamped viewer sees the zone they picked, with no clamp marker
  ✓ System Efficiency: no zone filter echoed reads as all zones, never as a blank chip
✓ #364 AC2 — the scorecard trend is drawn (3)
  ✓ draws the selected ZM's monthly series, which the client used to type `unknown[]` and discard
  ✓ switches series and metric without refetching the report
  ✓ says so, rather than drawing an empty chart, when the range has no monthly rows
✓ #364 AC3 — a report number links to the rows behind it (3)
  ✓ Reports landing: a zone row links to that zone's device list
  ✓ System Efficiency: a zone row links to that zone's device list, carrying the zone
  ✓ ZM Scorecard: a ZM row links to that zone's efficiency report over the same range
```

`apps/admin/test/exports-page.test.tsx` — **+3 tests** (`Exports page — finance voucher batch (#364)`)

```
✓ shows the approved-voucher row count for the picked month, counting only that month
✓ downloads the month's finance CSV from the existing export endpoint
✓ says the month is empty rather than offering a download of nothing
```

Five existing test files were updated mechanically: the four report pages now use `useSearchParams`
and `<Link>`, so bare `render(<Page />)` calls are wrapped in `<MemoryRouter>`
(`reports`, `fleet-uptime-honesty`, `system-efficiency`, `root-cause-analytics`, `zm-scorecard`).
`exports-page.test.tsx`'s two catch-all `mockImplementation`s became URL-routed, because a mock that
answers the entity-mapping summary to *every* URL now also answers the voucher queue.

**Full admin suite: 133 files, 1005 tests, all passing.** `npx tsc -b` clean. **No backend file was
touched, so no backend suite was run** (and no database lock was taken).

## Follow-ups this slice does not own

- **A `rootCause` filter on `GET /tickets`** (or a troubleshoot-submissions dataset in Ops Explorer).
  Without one, the Root Cause breakdown cannot drill to its rows — AC3's single gap, stated on the
  page rather than papered over with a link that filters nothing.
- **A device-type option source.** `device_type` is a free String with no enum and no endpoint listing
  its distinct values; adding `deviceTypes` to `GET /devices/filter-options` would turn the report
  pages' text box into a dropdown. Small, and it belongs with whoever owns `devices.service.ts`.
- **Zone / company / plant on `/reports/fleet-uptime`.** The endpoint takes `month` and `groupBy`
  only, so on the Reports landing those three filters narrow the two distributions but not the hero
  Fleet Uptime KPI. The month is shared, so no number is *wrong*; the KPI is simply broader than the
  panels beneath it.
- **The role chip on the report header band** (refs 21/23/24/25), which needs the report pages to be
  rendered inside `AuthProvider` — see the decision above.
