# 235 — Drill-through: filter the device list to recently commissioned devices

Status: ready-for-agent
Type: Feature (Backend + Admin) · Devices · AFK
Filed: 2026-08-13, from `audit/recently-commissioned-devices-investigation-2026-08-13.md` §4, §6.1
Coordinates with: [#232](./232-commissioning-cohort-view.md) (the cohort page this is entered from) ·
[#193](./193-zone-drilldown-enrichment.md) (the drill-down precedent on the same target page)

## What to build

The operator ask includes *"drill into individual device details."* That capability already exists
end to end and needs no new page: `/reports/device` (Device Detail list, zone/company/plant/status/
bucket filters), `GET /api/devices/:id`, `GET /api/devices/:id/cycles` (lifetime failure-cycle list)
and `GET /api/devices/:id/downtime-trend` (monthly series + root-cause trend) are all built and
manager-roled.

**The one thing missing is a way to narrow that list to the cohort.** Add one optional query
parameter, `commissionedWithinDays`, to `GET /api/devices` — an `EXISTS` predicate against
`device_commissioning` — and link the cohort page's plant and installer rows through to
`/reports/device?plantId=…&commissionedWithinDays=…`.

Two constraints that decide whether this is correct or merely convenient:

- **Reuse the cohort's predicate; do not restate it.** "Recently commissioned" must have exactly one
  definition. If this filter spells the window differently from `gradedSource`, the drill-through
  will land on a row count that does not match the card the user clicked.
- **State the grain on both surfaces.** The cohort card counts **fitments**; this list counts
  **devices**. Measured live over 90 days: 5,993 devices with 1 fitment, 400 with 2, 9 with 3, 3 with
  4 — **6.4% of cohort devices have more than one fitment in the window**, so the two numbers are
  legitimately different and will be read as a bug unless each says what it counts.

`GET /api/devices` already carries eight optional filters; a ninth is additive by construction.

## Acceptance criteria

1. **AC-1** With `commissionedWithinDays` absent, `GET /api/devices` behaviour is byte-identical to
   today. This is the regression floor — the endpoint backs a live page.
2. **AC-2** The filter derives from the same `device_commissioning` window predicate the cohort uses;
   there is no second definition of "recently commissioned" in the codebase.
3. **AC-3** The ZM zone clamp holds through the new filter — a ZM sees only their own zone's devices,
   proven by test, not asserted.
4. **AC-4** Cohort plant rows and installer rows link through to `/reports/device` with the filter and
   the row's own scope applied; the target page reads every param it is handed (verified against
   `DeviceDetailPage`'s actual param contract, which is the defect #217 S2 found and fixed).
5. **AC-5** Both surfaces state their grain — "fitments" on the cohort, "devices" on the list — so
   the 6.4% divergence reads as a fact rather than a discrepancy.
6. **AC-6** The parameter is bounded on the same ceiling as `COHORT_DAYS` (max 90), rejecting
   out-of-range input rather than clamping silently, matching `parseBoundedInt` in
   `reports.controller.ts`.

## UI surfaces

- `Admin: Device Detail list (/reports/device) — modified` (one filter chip + the incoming param)
- `Admin: Commissioning cohort (/reports/commissioning) — modified` (row links out) — owned by
  [#232](./232-commissioning-cohort-view.md) AC-1
- `Mobile: n/a`

## Reference

`docs/ui/desktop/v2-reference/22-device-detail.png`

## Blocked by

[#232](./232-commissioning-cohort-view.md) AC-1 — the page the drill-through is entered from must
exist first. The backend half of this slice is independently buildable and may land earlier.
