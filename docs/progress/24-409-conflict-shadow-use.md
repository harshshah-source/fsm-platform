# Progress — Issue 24: 409 Conflict + Shadow Use + reconciliation + inventory rollback

> Build date: 2026-06-24 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **ACCEPTED** (backend + admin Shadow Use Queue complete; mobile 409 screen → Issue 63).
> Backend **+6 test files / +1 service / migration 26**; admin **+1 page / +1 test**; `tsc --noEmit`
> clean both apps. Migration **20260624140000_add_inventory_transactions**.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Second submit on a closed Ticket returns a business 409 (distinct from idempotency duplicate) | 🟢 | `TroubleshootSubmissionService` → `CONFLICT` (winner SE/time) vs `DUPLICATE`; controller → HTTP 409 `TICKET_ALREADY_CLOSED`. `shadow-use-conflict` (3), `troubleshoot-submission` (3). |
| 2 | Consumed components decremented from Van Stock + logged as SHADOW_USE | 🟢 | 409 path writes SHADOW_USE `inventory_transactions` + `decrementStock`. `shadow-use-conflict` (3). |
| 3 | Mobile full-screen 409 screen | 🟡 | Backend returns the 409 payload (`winnerSeId`, `winnerAt`, `shadowUseRecorded`); **mobile screen → Issue 63** (blocked-by Mobile Foundation #54). |
| 4 | Shadow Use Queue: Mark Reconciled / Mark Disputed (dispute escalates to ZM, flags Ticket) | 🟢 | `ShadowUseService` + `/api/warehouse/shadow-use`; dispute → ZM-escalation audit + `INVENTORY_DISPUTE` ticket event; admin Shadow Use Queue page. `shadow-use-queue` (4), `shadow-use-controller` (1), `shadow-use-queue.test.tsx` (3). |
| 5 | Failed-verification inventory rollback (PRE_VERIFICATION → DEDUCTED handled) | 🟢 | Verification `finalize`: CLOSED → DEDUCTED; FAILED_VERIFICATION → ROLLED_BACK + van stock restored. `inventory-rollback` (2). |
| 6 | Two-SEs-same-Ticket reconciliation keeps both Van Stocks accurate | 🟢 | Winner consumption PRE_VERIFICATION (their stock down); loser SHADOW_USE (their stock down) — both accurate. `shadow-use-conflict` (3). |

## Slice-by-slice RED→GREEN report

- **Slice 1 — ledger schema.** `InventoryTransaction` + `InventoryTxnType` (TICKET_CONSUMPTION,
  FAULTY_COMPONENT_RETURNED) + `InventoryTxnStatus` (PRE_VERIFICATION, DEDUCTED, ROLLED_BACK,
  SHADOW_USE, RECONCILED, DISPUTED); migration 26 (FK chain, qty>0 CHECK). `inventory-transactions-schema` (2).
- **Slice 2 — 409 + shadow use + consumption.** `consumedComponents` input; business `CONFLICT`
  (winner SE/time) distinct from `DUPLICATE`; 409 → SHADOW_USE + decrement loser stock; normal submit →
  PRE_VERIFICATION + decrement; `decrementStock` helper. Controller 409 `TICKET_ALREADY_CLOSED`.
  `shadow-use-conflict` (3).
- **Slice 3 — verification rollback.** `finalize` flips this ticket's PRE_VERIFICATION txns to DEDUCTED
  on CLOSE, to ROLLED_BACK + restores van stock on FAILED. `inventory-rollback` (2).
- **Slice 4 — Shadow Use Queue.** `ShadowUseService` (queue/reconcile/dispute; dispute → ZM-escalation
  audit + INVENTORY_DISPUTE ticket event) + `/api/warehouse/shadow-use` controller (WM-only).
  `shadow-use-queue` (4), `shadow-use-controller` (1).
- **Slice 5 — admin UI.** `ShadowUseQueuePage` (`/warehouse/shadow-use`) per
  `v2-reference/19-shadow-use-queue.png`: unreconciled metric + table + Reconcile / Dispute-with-reason;
  route RoleRoute-gated to WAREHOUSE_MANAGER + WM nav link. `shadow-use-queue.test.tsx` (3).

## Deviations / decisions (read before extending)

1. **`type` vs `status` split.** `type` is the accounting category (Ticket Consumption / Faulty Return);
   `status` is the lifecycle. Shadow Use is a *status* (per CONTEXT), not a type — a 409-loser's row is
   `type=TICKET_CONSUMPTION, status=SHADOW_USE`.
2. **NOT_OPEN → CONFLICT rename.** The submission outcome's `NOT_OPEN` became `CONFLICT` carrying the
   winner + `shadowUseRecorded`; the controller maps it to 409 `TICKET_ALREADY_CLOSED` (was
   `TICKET_NOT_OPEN`). The separate auto-recovery `NOT_OPEN` (manual close) is unchanged.
3. **Consumed components are an optional input seam.** `consumedComponents` defaults to empty, so all
   existing submit/verification tests are unaffected; the mobile form supplies it once built. The
   `submission_components` join from the LLD is realised as ledger rows tagged with `submissionId`.
4. **Inventory Dispute is a ticket-event flag, not a column.** A dispute writes a no-transition
   `ticket_events` row (`reasonCode = INVENTORY_DISPUTE`, from === to) — surfaces on the timeline
   without schema churn.
5. **Van-stock decrement floors at 0 and no-ops when untracked** (seam-default; the ledger still records
   the physical movement).

## Parity-gate disposition (CLAUDE.md / workflow.md)

- **Admin surface built in-issue:** Shadow Use Queue page (net-new, v2-reference/19).
- **Mobile full-screen 409 screen** → **Issue 63** (filed + linked in INDEX), blocked-by Mobile
  Foundation #54. Backend already returns the 409 payload. Tracked, not a silent defer.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run \
  test/inventory-transactions-schema.e2e-spec.ts test/shadow-use-conflict.e2e-spec.ts \
  test/inventory-rollback.e2e-spec.ts test/shadow-use-queue.e2e-spec.ts test/shadow-use-controller.e2e-spec.ts
cd apps/admin && node node_modules/vitest/vitest.mjs run test/shadow-use-queue.test.tsx
```
