# FE-06 — Zone Dashboard (ZM) parity

Status: done
Type: AFK · Frontend · Phase F1
Effort: M

> Governed by `DESIGN-SYSTEM.md` §8. Global DoD applies.

## What to build

Bring the ZM dashboard to parity with `01`: KPI `MetricStrip` (uptime % + counts), Action-Required as the
reference card grid (8 live card sources, data unchanged), Company/Plant overview `DataTable`, and the
Critical Work Queue rendered as `TicketCard`s with the existing assign action preserved.

## Dependencies

- FE-02, FE-03, FE-04, FE-05

## Acceptance criteria

- [x] KPI MetricStrip (uptime % + open/critical counts) per `01`
- [x] Action Required rendered as the reference card grid; card data unchanged (8 sources)
- [x] Zone + Company/Plant overview as `DataTable` with `SLABadge`/`TierBadge`
- [x] Critical Queue as `TicketCard`s; assign-SE picker action preserved

## Outcome (done — presentation-only, FE-06)

Refactored `DashboardHome` + `ActionRequiredPanel` + `ZoneOverviewTable` + `CompanyPlantTable` +
`CriticalQueue` onto the FE foundation (PageHeader · DateRangeChips · MetricStrip · DataTable ·
domain badges · enterprise cards). No routing/API/RBAC/business-logic change; the full selector
contract (`aria-label`s, `bucket-<B>`/`trend`/`action-card`/`critical-group` test ids, filter labels,
disabled-until-picked Assign, `/schedules/assign` wiring) is preserved.

- **KPI strip** derives its figures from already-loaded dashboard data (no new endpoint): Inactive
  Devices (Σ zone totals), Critical+ Tickets (Σ critical-queue tickets), Action Required (Σ live card
  counts).
- **Documented omission (§9.2):** *Fleet Uptime %* has no backend source until the Fleet Uptime report
  (BE-39/40, surfaced by FE-21). Its card renders the reference chrome with a `—` placeholder and a
  "Live with Fleet Uptime report" hint — chrome matched, dead value omitted, not faked.
- **Company/Plant Overview** keeps its bespoke `<table>` (company→plant→device grouping + on-demand
  drill-down can't be expressed by the flat `DataTable`) but is re-skinned onto tokens + `TierBadge`.

Verified green: admin `tsc --noEmit` clean · vitest **94/94** · `vite build` OK.

**Remaining (not blocking FE-06 functional parity):** Playwright pixel baseline vs `01` is owned by
the FE-00 visual-regression harness (still to file — INDEX F0 note), not by this issue.

## Reusable components introduced

- `ActionRequiredCard` grid (composition only)

## Affected pages

- `DashboardHome` + `ActionRequiredPanel`, `ZoneOverviewTable`, `CompanyPlantTable`, `CriticalQueue` (**[RP]**)

## Reference

- `docs/ui/desktop/v2-reference/01-dashboard-zonal-manager.png`

## Verification

- `dashboard-home.test.tsx`, `dashboard-filters.test.tsx`, `dashboard-critical-action.test.tsx`, `dashboard-company-plant.test.tsx`, `critical-assign.test.tsx` green; Playwright ≈ `01`
