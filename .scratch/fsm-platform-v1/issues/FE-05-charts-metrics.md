# FE-05 — Chart + metric primitives

Status: done
Type: AFK · Frontend · Phase F0
Effort: M

> Governed by `DESIGN-SYSTEM.md` §5.1/5.6. Global DoD applies.

## What to build

The metric strip and the chart wrappers (recharts) used by dashboards, verification, and all reports.
Build `MetricStrip`/`MetricCard`, `BarChartCard`, `StackedBar`, `DistributionBar`, `DonutChart`,
`RadialGauge`, `TrendChart`, `ChartCard`. Prove by adding a faithful outcomes `DonutChart` + KPI strip to
`VerificationReviewPage`, bound to existing data.

## Dependencies

- FE-01 (adds `recharts`)

## Acceptance criteria

- [x] Each chart wraps recharts with tokenized colours, responsive container, empty/loading states
- [x] `MetricStrip` matches the dashboard/reports KPI row (numeral + caps label + delta/accent; `accent`/`icon`/`split`/`compact` variants)
- [x] `DistributionBar` reproduces the `04` SLA-bucket heat-ramp; `BarChartCard` reproduces `21` "Inactivity by SLA bucket"
- [x] `VerificationReviewPage` gains a faithful outcomes donut + KPI strip on existing data

## Reusable components introduced

- `MetricStrip`, `MetricCard`, `BarChartCard`, `StackedBar`, `DistributionBar`, `DonutChart`, `RadialGauge`, `TrendChart`, `ChartCard`

## Affected pages

- `VerificationReviewPage` (proof; **[RP]**)

## Reference

- `14`, `21`, `22`, `23`, `24`, `25`, `04` (distribution bar)

## Verification

- `verification-review.test.tsx` green; Playwright ≈ `14`
