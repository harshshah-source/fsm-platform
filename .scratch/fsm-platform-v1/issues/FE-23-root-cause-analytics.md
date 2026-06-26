# FE-23 — Root-Cause Analytics

Status: ready-for-agent
Type: AFK · Frontend (backend-paired) · Phase F5
Effort: M

> Governed by `DESIGN-SYSTEM.md` §5.6. Global DoD applies. **Backend-gated** (Issue 41).

## What to build

The Root-Cause Analytics page matching `23`: KPI strip, "Distribution" multi-colour `BarChartCard` (root
cause → %), "Breakdown" `DataTable` (cause → tickets / critical / component-related) bound to the Issue 41
analytics endpoint (structured root cause from troubleshoot forms).

## Dependencies

- FE-05 + **backend Issue 41 (Root Cause Analytics)**

## Acceptance criteria

- [ ] Page matches `23` (KPI + distribution bars + breakdown table)
- [ ] All data from the Issue 41 endpoint; empty/loading/error states

## Reusable components introduced

- (consumes FE-05)

## Affected pages

- new `/reports/root-cause` (**[N]** page)

## Reference

- `docs/ui/desktop/v2-reference/23-root-cause-analytics.png`

## Verification

- new root-cause test; Playwright ≈ `23`
