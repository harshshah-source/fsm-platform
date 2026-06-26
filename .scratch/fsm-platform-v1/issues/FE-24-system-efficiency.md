# FE-24 — System Efficiency report

Status: ready-for-agent
Type: AFK · Frontend (backend-paired) · Phase F5
Effort: M

> Governed by `DESIGN-SYSTEM.md` §5.6. Global DoD applies. **Backend-gated** (Issue 42).

## What to build

The System Efficiency page matching `24`: dense KPI grid (auto-dispatch %, acceptance, escalation, avg
hours), "SE active load vs capacity" `BarChartCard`, "Auto-dispatch by zone" stats, "Recent overrides &
audit" panel — bound to the Issue 42 endpoint.

## Dependencies

- FE-05 + **backend Issue 42 (System Efficiency Report)**

## Acceptance criteria

- [ ] Page matches `24` (KPI grid + capacity bars + auto-dispatch-by-zone + audit panel)
- [ ] All data from the Issue 42 endpoint; empty/loading/error states

## Reusable components introduced

- (consumes FE-05)

## Affected pages

- new `/reports/system-efficiency` (**[N]** page)

## Reference

- `docs/ui/desktop/v2-reference/24-system-efficiency.png`

## Verification

- new system-efficiency test; Playwright ≈ `24`
