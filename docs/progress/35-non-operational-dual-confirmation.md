# Progress — Issue 35: Non-Operational dual-confirmation marking

> Build date: 2026-06-25 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE (backend + admin)** — full dual-confirmation lifecycle, CONFIRMED side-effects,
> customer tokenised-email seam, and the admin dual-confirmation queue + Mark modal. Backend
> **+1 service / +1 controller pair / +1 notifier seam / +1 additive migration / +5 e2e files (19 tests)**;
> admin **+1 page / +1 api client / +1 test (3)**. Backend **509/509**, admin **82/82**, both `tsc` clean.
> First real consumer of the #47 RequestActor seam (acting attribution audited on a ZM-scoped mutation).

## Authority

CONTEXT.md **§14** ("Non-Operational marking requires dual confirmation; recurring-deal Devices trigger a
Recovery Ticket") is the governing rule. The schema already reserved `NonOpState` + a minimal
`NonOperationalMarking` (Issue 05) noting the full lifecycle "lands with Issue 35 as an additive
migration" — so the migration here is pre-sanctioned, not a new architecture decision.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Dual-confirmation queue with correct row states + days-elapsed badges | 🟢 | `NonOperationalService.queue()` returns open markings sorted by `awaiting_since` asc with a derived `daysElapsed`; `GET /api/non-op/queue` (manager roles). Admin `/readiness/non-operational` renders a state badge (Awaiting Manager / Awaiting Customer / Confirmed) + a days badge. `non-operational-request-queue` (5), `non-operational-queue.test` (3). |
| 2 | CONFIRMED only after both parties confirm (or OH 7-day override) | 🟢 | `confirmByManager` + `confirmByCustomer` advance order-independently; both legs → CONFIRMED. `overrideConfirm` is Operations-Head-only, gated to ≥7 days awaiting, mandatory reason. `non-operational-confirm` (5). |
| 3 | CONFIRMED blocks new Failure Cycles + auto-closes in-flight Tickets | 🟢 | `runConfirmedSideEffects` closes OPEN/SUBMITTED/VERIFICATION_PENDING/ESCALATED tickets as `CLOSED_NON_OPERATIONAL` (back-ref `nonop_marking_id` + `ticket_events` row) and sets `device_states.eligible_for_uptime = false` (the ticket-creation gate requires `eligible = true`, so new cycles are blocked). `non-operational-confirmed-effects` (3). |
| 4 | RECURRING device on CONFIRMED auto-creates + queues a Recovery Ticket (toast number) | 🟢 | `maybeCreateRecoveryTicket`: `deal_type_at_marking = RECURRING` AND reason ∈ {SCRAPPED, SOLD, COMPANY_PAUSED, REPLACEMENT_PENDING} → a `RECOVERY` ticket in `REQUESTED` / `UNASSIGNED` (queued to the recommender like any ticket), back-ref + `marking.recovery_ticket_id`. The number is surfaced on the queue row (`recoveryTicketId`); see deviation 3 re: the literal toast. |
| 5 | Confirmed device excluded from Fleet Uptime eligible set | 🟢 | Same `eligible_for_uptime = false` write; the existing eligibility recompute also treats `CONFIRMED/ACTIVE` as ineligible, so the exclusion is durable across recomputes. |
| 6 | Customer confirmation via one-time tokenised email link | 🟢 | `requestMarking` issues a one-time `customer_token` (+30-day expiry) and fires it through the `CustomerConfirmationNotifier` seam (logging stub; Issue 03 swaps it). `confirmByCustomerToken` resolves + consumes the token; expired/unknown rejected. Public `GET /api/non-op/confirm?token=` (no auth). `non-operational-customer-token` (2) + controller e2e (4). |

## Slice-by-slice RED→GREEN report

- **Slice 1 — schema + request + queue.** Additive migration `20260625120000_add_nonop_dual_confirmation`
  (reason/window/deal-type-snapshot/dual-confirm timestamps/customer token/override fields/recovery
  back-ref + `tickets.nonop_marking_id`). `requestMarking` snapshots deal type, defaults the window
  (90d, 365d scrapped/sold), one-active-marking guard, OTHER-needs-text. `queue` sort + days badge.
  RED `non-operational-request-queue` (5).
- **Slice 2 — dual-confirm + override.** `confirmByManager` / `confirmByCustomer` (order-independent),
  manager-role gate, `overrideConfirm` (OH-only, 7-day gate, mandatory reason). RED `non-operational-confirm` (5).
- **Slice 3 — CONFIRMED side-effects.** Auto-close in-flight tickets (+ event + cycle `closed_at`),
  eligibility exclusion, Recovery-Ticket auto-create for qualifying RECURRING. Both the dual path and
  the override path funnel through one `markConfirmed`. RED `non-operational-confirmed-effects` (3).
- **Slice 4 — customer token seam + HTTP.** `CustomerConfirmationNotifier` port + logging stub;
  token issuance + `confirmByCustomerToken` (one-time, expiry); `NonOperationalController` (manager +
  OH endpoints, `@CurrentActor()`) + public `NonOperationalPublicController`. RED
  `non-operational-customer-token` (2) + `non-operational-controller` (4, incl. acting-attribution audit).
- **Slice 5 — admin queue + Mark modal.** `/readiness/non-operational` (manager nav + RoleRoute):
  state + days badges, manager Confirm, OH Override-confirm; Mark-Non-Operational modal with reason +
  window + the RECURRING Recovery warning gated behind an explicit acknowledgement checkbox. RED
  `non-operational-queue.test` (3).

## Deviations / decisions

1. **Stored state vs. display labels.** The schema enum uses `AWAITING_ZM_CONFIRMATION`; the issue's
   "AWAITING_MANAGER_CONFIRMATION" is the display label (rendered "Awaiting Manager"). The two
   confirmation legs are tracked by `manager_confirmed_at` / `customer_confirmed_at`; `state` reflects
   the still-outstanding party and is order-independent.
2. **Failure-cycle termination.** There is no `NON_OPERATIONAL` Failure-Cycle terminal state, so an
   auto-closed cycle is terminated via `closed_at` (+ `has_open_failure_cycle = false`); its `state`
   label is left unchanged (the device left service; it never recovers). A dedicated terminal label
   can be added later if Root-Cause analytics (#41) needs to distinguish it.
3. **Recovery number surfaced on the row, not a toast.** AC#4's "toast with the number" — because
   CONFIRMED is normally reached *later* via the async customer email link (not at the manager's
   click), a click-time toast wouldn't fire. The number is instead shown on the CONFIRMED queue row
   (`↻ <ticketId>`). A literal toast is a minor follow-up affordance, not a deferred capability.
4. **Mark modal shows a generic auto-close warning, not the enumerated ticket list.** Listing the
   exact in-flight tickets that will close needs a tickets-by-device read; filed as **#67**.
5. **Queue is not zone-scoped.** Unlike sibling queues, `/non-op/queue` returns all open markings
   (device→zone resolution needs a join). Acceptable for v1 (the issue specifies sort, not scoping);
   folded into **#67** as a refinement.

## Parity-gate disposition

- **Admin:** built (queue + confirm + override + Mark modal). ✅
- **Mobile:** **n/a** — Non-Operational is a manager/Operations workflow; the customer leg is an
  email link (no portal), and there is no SE mobile surface in §14. No mobile follow-up.
- **Follow-up #67** (filed + linked in INDEX): enumerate auto-close tickets in the Mark modal +
  zone-scope the queue + literal Recovery-Ticket toast. Compliant — the in-scope ACs are built; #67
  carries UI refinements, not a dropped capability.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run \
  test/non-operational-request-queue.e2e-spec.ts test/non-operational-confirm.e2e-spec.ts \
  test/non-operational-confirmed-effects.e2e-spec.ts test/non-operational-customer-token.e2e-spec.ts \
  test/non-operational-controller.e2e-spec.ts
cd apps/admin && node node_modules/vitest/vitest.mjs run test/non-operational-queue.test.tsx
```
