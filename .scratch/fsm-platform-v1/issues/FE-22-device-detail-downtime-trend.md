# FE-22 — Device Detail + lifetime downtime trend

Status: ready-for-agent
Type: AFK · Frontend (backend-paired) · Phase F5
Effort: M

> Governed by `DESIGN-SYSTEM.md` §5.6. Global DoD applies. **Backend-gated** (Issue 44).

## What to build

The Device Detail page matching `22`: device list `DataTable` + selected-device header (lifecycle/downtime/
avg-recovery/component-release stats) + current-failure-cycle panel + "Lifetime downtime trend" `TrendChart`
(per-month bars) with a summary-table toggle. Closes Issue 49's deferred deal_type tag control.

## Dependencies

- FE-05 + **backend Issue 44 (Device Detail + downtime trend)**

## Acceptance criteria

- [ ] Device Detail matches `22` (list + detail header stats + failure-cycle panel + downtime trend)
- [ ] Lifetime downtime `TrendChart` + summary-table toggle from the Issue 44 endpoint
- [ ] Ops-Head `deal_type` tag control surfaced (closes Issue 49 deferred UI)

## Reusable components introduced

- `DeviceDetailHeader` (composition)

## Affected pages

- new `/reports/device/:id` (or `/devices/:id`) (**[N]** page)

## Reference

- `docs/ui/desktop/v2-reference/22-device-detail.png`

## Verification

- new device-detail test; Playwright ≈ `22`
