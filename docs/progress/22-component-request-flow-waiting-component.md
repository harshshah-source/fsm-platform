# Progress — Issue 22: Component Request flow + WAITING_COMPONENT pause + resubmit

> Build date: 2026-06-24 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **ACCEPTED** (backend + admin queue complete; mobile screens owned by tracked follow-ups).
> Backend **+6 test files / +1 module / migration 25**; admin **+1 page / +1 test**; `tsc --noEmit`
> clean both apps. Migration **20260624120000_add_component_request**.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | `component_unavailable=true` raises a Component Request and moves cycle to WAITING_COMPONENT | 🟢 | `troubleshoot-submission.service` branch; `component-request-raise` (3). Ticket stays OPEN (ADR-0008), cycle → WAITING_COMPONENT, REQUESTED request raised. |
| 2 | Primary SLA pauses with `pause_reason = WAITING_COMPONENT` | 🟢 | Same branch sets `slaPaused/slaPauseReason/slaPausedAt/slaPauseSource`. `component-request-raise` (3). |
| 3 | WM Approve → Mark Shipped (tracking) or Reject (mandatory reason, ZM notified) | 🟢 | `ComponentRequestService.approve/markShipped/reject`; state-guarded. `component-request-warehouse` (5) + HTTP `component-request-controller` (4). ZM-notify recorded as audit (Issue 03 delivery seam). |
| 4 | SE Confirm Receipt sets RECEIVED and resumes SLA per the configured resume trigger | 🟢 | `confirmReceipt` + `sla_resume_on_receipt` switch (default OFF → resume at resubmit). `component-request-receipt` (4). |
| 5 | Resubmit reopens the form with a new `client_submission_id` on the same Ticket | 🟢 (backend) / 🟡 (mobile screen) | `confirmResubmit` reopens cycle WAITING_COMPONENT → OPEN; a fresh `submit()` creates a 2nd submission on the same cycle. `component-request-resubmit` (4). **Mobile resubmit form → Issue 58 (M4)**, blocked-by Mobile Foundation #54. |
| 6 | Resubmit ownership rules applied for Dedicated/Multi-Plant vs Floating SE | 🟢 | `computeResubmitOwnership`: Dedicated/Multi-Plant soft-own; Floating SE_LOCATION → original, PLANT_WAREHOUSE → pool (ticket UNASSIGNED). `component-request-resubmit` (4). |

## Slice-by-slice RED→GREEN report

- **Slice 1 — schema.** `ComponentRequest` model + `ComponentRequestStatus` (REQUESTED→APPROVED|REJECTED
  →SHIPPED→RECEIVED) + `DeliveryDestination` (SE_LOCATION|PLANT_WAREHOUSE); migration 25 (one-request-
  per-submission unique, FK chain). `component-request-schema` (3).
- **Slice 2 — raise + pause.** `TroubleshootSubmissionService.submit` branches on `componentUnavailable`:
  ticket stays OPEN, cycle → WAITING_COMPONENT, SLA pauses, REQUESTED request raised; idempotent via the
  submission's own `client_submission_id`. Normal path unchanged. `component-request-raise` (3).
- **Slice 3 — WM flow.** `ComponentRequestService` queue/approve/markShipped/reject; state-guarded
  `transition()` helper + audit. `component-request-warehouse` (5).
- **Slice 4 — Confirm Receipt + resume switch.** `confirmReceipt` (SHIPPED → RECEIVED) +
  `resolveResumeOnReceipt` (`sla_resume_on_receipt`, default OFF) + `resumeSla` (accumulates paused
  seconds). `component-request-receipt` (4).
- **Slice 5 — resubmit binding.** `confirmResubmit` (ZM): resume SLA at manager-confirmation, reopen
  cycle, `computeResubmitOwnership`; fresh form submit creates a 2nd submission. `component-request-
  resubmit` (4).
- **Slice 6 — HTTP.** `WarehouseRequestsController` (`/api/warehouse/requests`, WM) +
  `ComponentRequestController` (`/api/component-requests/:id/confirm-receipt|confirm-resubmit`) +
  `ComponentRequestModule` wired in AppModule; WM dev-seed user `wm@fsm.test`. Outcomes → 200/400/404/409.
  `component-request-controller` (4).
- **Slice 7 — admin UI.** `ComponentRequestsPage` (`/warehouse/requests`) per
  `v2-reference/18-component-requests.png`: lifecycle metric strip + table + WM row actions
  (Approve / Mark Shipped / Reject-with-reason); route RoleRoute-gated to WAREHOUSE_MANAGER + WM nav
  link. `component-requests.test.tsx` (3).

## Deviations / decisions (read before extending)

1. **Ticket stays OPEN on component-unavailable** (ADR-0008): the PRD's `VERIFICATION_PENDING_COMPONENT`
   literal is dropped; the "awaiting component" signal is the Failure Cycle's `WAITING_COMPONENT` state.
2. **SLA resume trigger is a config switch.** `sla_resume_on_receipt` (SystemSetting) defaults OFF →
   resume binds at the ZM-confirmed resubmit (`confirmResubmit`), matching ADR-0008 ("resumed at
   manager-confirmation, not at delivery"). ON resumes at Confirm Receipt. `resumeSla` is shared.
3. **Resubmit ownership is computed, not stored.** Derived from `engineer.coverageType` +
   `request.deliveryDestination` at confirm time and returned to the caller; only RETURN_TO_POOL has a
   persisted side effect (ticket → UNASSIGNED). Wiring the SOFT_OWN_ORIGINAL preference into the
   Recommender's soft-bias is a future enhancement (the planner soft-bias mechanism already exists).
4. **Notifications are seamed.** "ZM notified on reject" / "SE push on ship" are recorded as audit
   events; delivery (push/WhatsApp) is the notification spine (Issue 03, HITL) — the external seam.

## Parity-gate disposition (CLAUDE.md / workflow.md)

- **Admin surface built** in-issue: Component Requests queue page (net-new, v2-reference/18).
- **Ticket Detail Components tab** (request status + WAITING_COMPONENT pause): the deep-link target
  `/tickets/:id?tab=Components` exists (Issue 21); the tab-body enrichment is owned by **Issue 62**
  (drawer-retrofit A1) — filed + linked in INDEX.md. Not a silent defer.
- **Mobile surfaces** (SE Confirm Receipt + resubmit form): owned by **Issue 58 (M4)** and **Issue 60
  (M6)**, both `blocked-by #54` (Mobile Foundation). Tracked, gate-compliant.

## Follow-ups (filed)

- **Issue 62** — Ticket Detail Components tab: request status + WAITING_COMPONENT pause → 22.
- Mobile resubmit/receipt → Issues 58 / 60 (existing M-series).
- Expected-component Hard-Filter leg → Issue 51 (existing; closes Issue 21 AC#2b, complements this loop).

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run \
  test/component-request-schema.e2e-spec.ts test/component-request-raise.e2e-spec.ts \
  test/component-request-warehouse.e2e-spec.ts test/component-request-receipt.e2e-spec.ts \
  test/component-request-resubmit.e2e-spec.ts test/component-request-controller.e2e-spec.ts
cd apps/admin && node node_modules/vitest/vitest.mjs run test/component-requests.test.tsx
```
