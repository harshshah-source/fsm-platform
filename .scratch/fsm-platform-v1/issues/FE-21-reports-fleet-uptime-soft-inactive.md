# FE-21 — Reports landing + Fleet Uptime + Soft-Inactive trend

Status: ready-for-agent
Type: AFK · Frontend (backend-paired) · Phase F5
Effort: L

> Governed by `DESIGN-SYSTEM.md` §5.6/§8. Global DoD applies. **Backend-gated** — build the BE slice first.

## What to build

The Reports landing page matching `21`: KPI `MetricStrip` (6-up), "Inactivity by SLA bucket" `BarChartCard`,
"Work type mix" `StackedBar`, "Verification outcomes" `DonutChart`, "Zone breakdown" `DataTable`, Fleet
Uptime % `TrendChart` (Issue 39) and Soft-Inactive count trend (Issue 40). Pairs with backend 39/40.

## Dependencies

- FE-05 + **backend Issue 39 (Fleet Uptime %)** + **backend Issue 40 (Soft-Inactive trend)**

## Acceptance criteria

- [ ] Reports landing matches `21` (KPI strip + bars + donut + zone-breakdown table)
- [ ] Fleet Uptime % monthly `TrendChart` from the Issue 39 endpoint
- [ ] Soft-Inactive count trend from the Issue 40 endpoint
- [ ] All metrics from real backend endpoints; empty/loading/error states

## Reusable components introduced

- `ReportGrid` (composition)

## Affected pages

- new `/reports` landing (replaces stub; **[N]** page)

## Reference

- `docs/ui/desktop/v2-reference/21-reports.png`

## Verification

- new reports test; Playwright ≈ `21`
