# 368 — DECISION RECORD: SE productivity report page

Status: `ready-for-agent` — decided 2026-09-03 by the operator. Unblocks [#365](./365-se-productivity-report.md).

**Design:** [`docs/ui/desktop/approved-designs/se-productivity-report.html`](../../../docs/ui/desktop/approved-designs/se-productivity-report.html)
**Covers:** `/reports/se-productivity` — the page body. Page chrome stays governed by
`docs/ui/desktop/v2-reference/21-reports.png`.

## The question put to the operator

#365 was filed with a **design stop**: the PRD names an SE productivity report but no v2 reference
image was ever drawn for it, and the plan's rule is that "no image exists" must never become a
licence to invent a layout. The metrics themselves were never in question — they are fixed by #365's
acceptance criteria (closures by type, first-time-fix rate, failed-verification rate, average
on-site → submission time, weekly/monthly, zone-clamped). What needed deciding was the **shape of
the page**: a filterable roster table, a per-SE scorecard with a trend chart, or ranked outlier cards.

## The decision

**A filterable table, one row per engineer**, reusing the filter bar and header band #364 built.

The reasoning that settled it: the question a manager brings to this page is *which of my engineers
needs attention*, and a table answers that in one read. A per-SE scorecard requires you to already
know the name before you can look it up, which makes it the wrong **first** screen — it is a
reasonable second screen later, reached by clicking a row. Ranked cards answer the question but
invite league-table misuse of metrics with small per-SE samples.

## Two constraints that came with the decision

- **Rates are suppressed below a small-sample threshold.** A floating SE with six closures has no
  meaningful first-time-fix percentage, and rendering one invites action on noise. Counts are always
  shown — a count of six is a true fact about six jobs.
- **Diagnostic surface, not a league table.** No ranking, no "best engineer" badge, no whole-row
  colouring. Only individual out-of-band metrics are marked, so the eye lands on a number worth
  asking about rather than a person worth blaming. Default order is by name, sortable, never
  pre-sorted worst-first.

## Prerequisite this does not waive

Audit finding **F7** stands: `se_repaired_closures` mis-attributes departure closures
(`fleet-uptime-aggregation.service.ts`), so an engineer whose plants had vehicles leave the fleet
reads as more productive than one who repaired devices. #365 fixes the aggregation **before** the
page exists — Repair and Departure are separate columns in the approved design precisely so the
split is structural rather than optional. A page built on the unsplit column would publish the
mis-attribution to the people who make staffing decisions.
