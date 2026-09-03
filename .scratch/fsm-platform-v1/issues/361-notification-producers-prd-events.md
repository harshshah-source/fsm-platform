# 361 — Notification producers for the remaining PRD events
Status: done 2026-09-04 - report docs/progress/361-notification-producers-prd-events.md
Type: AFK
Wave: 4 · Severity: P2 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

PRD story 72 lists SLA warnings, verification failures, component approvals, batch status changes
and recovery decisions as events that notify someone. The following producers are missing:

- Component request APPROVED / SHIPPED / REJECTED — `component-request.service.ts:323-350` writes
  audit only (INV-G3).
- Common-Kit-short / component blocked — `inventory.service.ts:107-125` (INV-G7, #53).
- 7-day waiting-component escalation notice to the ZM (INV-G4). Per §1: the surfacing already
  exists (`waiting_component_overdue` card, zone-scoped >7 d, `dashboard.service.ts:976-995`);
  only the pushed notice is missing.
- SLA-warning at bucket crossing.
- Snapshot FAILED / overdue notice to OH.
- Departure auto-close notice to the ZM — `device-departure.service.ts:299-334` (ING-01). Per §1
  the auto-close is audited (`:373,411`); the surfacing goes to #349, the notice is this slice.
- Voucher decisions — `vouchers.module.ts:17` binds `LoggingVoucherNotifier` while
  `VoucherReviewPage.tsx:24,228` claims the SE is notified (VCH-07).

## Current code

- `apps/backend/src/inventory/component-request.service.ts:323-350` — status transitions, audit
  only.
- `apps/backend/src/inventory/inventory.service.ts:107-125` — Common Kit / component-blocked
  evaluation, no notice.
- `apps/backend/src/dashboard/dashboard.service.ts:976-995` — `waiting_component_overdue` card
  (surfacing exists; no push).
- `apps/backend/src/ingestion/autoplant/device-departure.service.ts:299-334` — departure
  auto-close, audited, no notice.
- `apps/backend/src/ingestion/ingestion-alert.ts` — alert/overdue detection (overdue arrives with
  #348), no OH notice on transition.
- `apps/backend/src/vouchers/vouchers.module.ts:17` — `LoggingVoucherNotifier` bound.
- `apps/admin/src/pages/vouchers/VoucherReviewPage.tsx:24,228` — copy claims the SE is notified.

## What to build

- Producers in each file above, using the #338 `queueNotification(tx, …)` helper inside the
  mutation's own transaction.
- New `vouchers/notification-voucher-notifier.ts`, bound in `vouchers.module.ts` in place of the
  logging notifier, so the Voucher Review page wording becomes true.
- SLA-warning sweep producer where the bucket recompute runs (`device-state` / ticket SLA
  service).
- `ingestion-alert.ts` — OH notice on transition into alert / overdue.
- Sweep-driven events deduplicated per (event, entity, day).
- Tests: `notifier-adoption-wiring.e2e-spec.ts` extended per event,
  `component-request-warehouse`, `voucher-service` e2e.

## Acceptance criteria
- [x] AC1 — one notification per listed event, to the role the PRD names: SE for ship/reject and
      kit-short, WM for approval requests, ZM for waiting-component and departure auto-close, OH for
      snapshot failed/overdue, SE for voucher decisions
- [x] AC2 — every producer enqueues via the #338 helper inside the mutation transaction
- [x] AC3 — sweep-driven events are deduplicated per (event, entity, day); a double sweep yields one
      notice
- [x] AC4 — the Voucher Review page's "SE is notified" wording is true, or removed

## Verification

`notifier-adoption-wiring.e2e-spec.ts` extended with one case per event (row exists in-tx, correct
recipient role, sweep dedup); `component-request-warehouse` and `voucher-service` e2e.

## UI surfaces

Admin: Voucher Review page (existing copy becomes accurate; no layout change).

## Reference

n/a (no layout change).

## Blocked by
- #337 — push delivery exit.
- #338 — durable outbox for every post-commit notify site (the in-tx helper this slice uses).

## Absorbs / supersedes
- survey ids: NOTIF-06, INV-G3, INV-G4 (notice only), INV-G7, ING-01 (notice half; surfacing is
  #349), VCH-07.
- existing issues: #53 — closes into this slice when it lands; #76 — the adoption remainder
  closes into this slice when it lands (customer confirmation excluded, see below).

## Decisions recorded

- **TKT-09** — Customer confirmation channel (SMS/WhatsApp to a non-user). Default assumed:
  **external seam; stays on #76** (HITL accounts). Not built here.
