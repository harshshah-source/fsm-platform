# reports

STATUS: estimated  updated 2026-09-02
COMPLETE: 48%  ->  63% after backlog
GAPS: 11 (S4 0 · S3 3 · S2 4 · S1/S0 4)  DANGEROUS 2 · needs-verify 0
EST: P50 47.41M · P80 94.82M TEQ · size XXL · risk HIGH · conf LOW · basis borrowed
VERDICT: The fleet uptime dashboard shows finance a fabricated 100% for the current month while the one month with a real computed number came in 41.81 points under the contractual target — the tool is not silent about missing data, it invents a recovery.

## The picture
Reports is under half built end to end (48%, rising to 63% after the backlog), and its worst problem is a data-freshness bug wearing a UI costume, not a screen bug: Fleet Uptime returns `uptimePct: 100` with zero eligible devices for the current month because an empty window is coded to mean "perfect," while the one month with a real cube (2026-07) reads 56.19% across 15,311 devices — the 6-month trend literally goes 100, 100, 100, 56.19, 100, 100, which reads as a recovery story rather than as missing data. Capability scoring understates this: it looks like one hero tile, but the cause chain runs through domain math, the cron scheduler that only ever writes last month, and the controller's month default — three files, not a UI patch. One other headline gap is cheaper than it looks: RPT-03's "no computed-at timestamp" is a discarded column in a select list, not a missing writer, since the timestamp is already stored and another endpoint in the same app returns it correctly.

## What matters, ranked
S4 / S3 / DANGEROUS / one-way doors only. Worst first. <=8 bullets. Always one 🟢 that works.
- 🔴 Empty uptime cube renders as a perfect 100% fleet score — current month is 100%/0 eligible devices vs the real July cube's 56.19% across 15,311 devices; against the 98% contractual target that's 41.81 points under vs 2 points over, and the 6-month trend invents a recovery instead of showing no-data (RPT-01, S3, dangerous)
- 🟠 Exports hub has no finance voucher batch card (RPT-08, S2, dangerous)
- 🟠 No report says when its number was computed — cheaper than it looks: `computed_at` is a NOT NULL column the projection just discards, while a sibling endpoint in the same app returns `dataAsOf` correctly, so this is a select-list fix not a writer fix (RPT-03, S3)
- 🟠 Monthly report cubes never cover the month the screens ask for — this is the root cause feeding RPT-01, and it's also the cheapest big fix in the module (RPT-02, S3)
- ⚠ number-health: top-down (screen count) vs bottom-up split at 3.29×, past the 2× low-confidence line — top-down assumes cost is screen-shaped, this module's real cost is data-freshness and control-shaped, the two counts should not be averaged
- ⚠ number-health: RPT-03, RPT-04, RPT-05, RPT-08 each price over 3M TEQ, past the brief's own "split before you commit" line — none should be quoted as a single unit of work
- ⚠ number-health: 2.74M TEQ of this estimate leans on thin cohorts — integration n=6 (RPT-08), data n=4 (RPT-02, RPT-05)
- 🟢 Zone clamping genuinely holds in SQL and the response tells the truth instead of flattering the request — `zm.north` asking for zoneId=2 gets zone 1 back, honestly labelled, and the ZM Scorecard is correctly 403 for both ZM and CSM

## Numbers
| | |
|---|---|
| functionally complete | 48% now → 63% after backlog |
| backlog | P50 47.41M / P80 94.82M TEQ · conf LOW |
| cheapest big fix | RPT-02 at 2.90M — Monthly report cubes never cover the month the screens ask for |
| engineering size / risk | XXL / HIGH — **not a schedule** |

## Not finished / needs you
- **needs-verify:** none
- **your call:** none
- **not walked:** ReportsPage hero tile rendering — that uptimePct 100 is painted green with tone 'success' is E2 from ReportsPage.tsx:107, NOT observed. Screen-only claim ⇒ NEEDS-VERIFY, cost one browser walk ~708k TEQ (screen: Reports; control: the 'Fleet Uptime' hero KPI card and its 6-month trend chart).; 'Data as of {asOf}' string on ReportsPage.tsx:240 — that the page prints today's date over a July cube is E2, not observed. Same browser walk would settle it alongside the tile.; check 8 (named downstream consumer) for C1/C2/C4/C5/C6/C7/C8/C9/C10 — every report's consumer is an admin page, unreachable by api-walk. Left '?' in coverage.json.; RPT-04 drill-through absence — no clickable metric on RootCauseAnalyticsPage / ZmScorecardPage / SystemEfficiencyPage. Absence of a control is browser-only; the five not-found checks are recorded in coverage.json C13, so it stays E2.; RPT-06 filter controls — that no screen offers a zone/date picker is a UI-absence claim; the bare zero-arg clients (api/reports.ts:120,137,172,201) are E2 and sufficient for the price, but the screens were not opened.; RPT-07 ZM scorecard trend[] not drawn — could not confirm the chart is absent; also note the OH call returned trend:[] on live data, so even a built chart would render empty today.; RPT-08 / H5 Exports hub card inventory — ExportsPage.tsx:12 shows one card in source; not visually confirmed, and the vouchers-screen export was not exercised. H5 left NEEDS-VERIFY.; POST /reports/*/recompute — not fired. Writing a cube would have made the current month non-empty and destroyed the RPT-01 evidence for later walkers; deliberately not run (SURVEYOR law, read-only).; Direct psql inspection of device_downtime_summary_monthly — no psql client on this host. Absence of rows is evidenced by the API (eligibleDeviceCount 0 + rows []) rather than by a table count.; work-type-mix and verification-outcomes endpoints — not called; RPT-03's freshness contrast was settled on four endpoints, a fifth adds nothing.
- **⚠ weak anchor:** 2.74M TEQ of this estimate rests on cohorts with n<10
- **⚠ cross-check split:** top-down 14.40M vs bottom-up 47.41M (3.29×) — module is LOW-CONFIDENCE

## All gaps, one line each
| id | sev | ⚠ | what (plain words) | type | size | P50 | conf |
|---|---|---|---|---|---|---|---|
| RPT-01 | S3 | ☠ | Empty uptime cube renders as a perfect 100% fleet score | FIX | M | 2.16M | HIGH |
| RPT-02 | S3 |  | Monthly report cubes never cover the month the screens ask for | FIX | M | 2.14M | HIGH |
| RPT-03 | S3 |  | No report says when its number was computed | NEW | M | 3.09M | HIGH |
| RPT-04 | S2 |  | No drill-through from any report number to its source records | NEW | L | 4.23M | MED |
| RPT-05 | S2 |  | No SE productivity report for the weekly workforce review | NEW | L | 6.26M | MED |
| RPT-06 | S2 |  | Report filters exist in the API but no screen sends them | COMPLETE | M | 2.44M | HIGH |
| RPT-08 | S2 | ☠ | Exports hub has no finance voucher batch card | INTEGRATION | L | 4.96M | MED |
| RPT-07 | S1 |  | ZM scorecard monthly trend computed but never drawn | COMPLETE | S | 0.80M | HIGH |
| RPT-09 | S1 |  | Report tests seed a month, never test the empty month | FIX | S | 0.43M | HIGH |
| RPT-G1 | S0 | ✗ | STRENGTH: zone clamp and role gate hold server-side on reports | NONE | — | — | HIGH |
| RPT-G2 | S0 |  | STRENGTH: ZM Scorecard is OH-only in the backend, not just the router | NONE | — | — | HIGH |

Evidence: `.work/reports/` · estimate: `.work/reports/estimate.json`
