# 353 — Inventory ledger closure: dispute restore, recovery receipt, ZM dispute view
Status: done 2026-09-03 — report docs/progress/353-inventory-ledger-closure.md
Type: AFK
Wave: 3 · Severity: P2 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

Three places where the inventory ledger stops short of the truth.

`inventory/shadow-use.service.ts:72-99` `markDisputed` flips the status and writes an audit row but
never restores the losing SE's van stock (contrast `verification.service.ts:400-415`, which does
compensate). Recovery `confirmWarehouseReceipt` (`ticketing/recovery.service.ts:138-169`) closes the
ticket and writes no stock or transaction row; `warehouse-stock.service.ts` has no increment API at
all. And the Shadow Use routes are WM-only (`shadow-use.controller.ts:41-56`), so the ZM a dispute is
"escalated to" can never see it.

## Current code

- `inventory/shadow-use.service.ts:72-99` — `markDisputed` flips status + audit, no stock restore.
- `verification.service.ts:400-415` — the compensating pattern to mirror.
- `ticketing/recovery.service.ts:138-169` — `confirmWarehouseReceipt` closes the ticket, no ledger row.
- `warehouse-stock.service.ts` — no increment API.
- `shadow-use.controller.ts:41-56` — routes WM-only.

## What to build

- `shadow-use.service.ts` — compensating `SHADOW_USE_DISPUTE_RESTORE` transaction plus the
  `se_van_stock` increment, in the same tx as the dispute.
- `recovery.service.ts` — write a `RECOVERY_RECEIPT` `inventory_transactions` row keyed by device;
  increment `zone_warehouse_stock` only when a device→component mapping exists (decision item §7
  INV-G2; default: transaction row only).
- `warehouse-stock.service.ts` — add `increment`.
- `shadow-use.controller.ts` — add a ZM zone-scoped `GET /shadow-use?status=DISPUTED`.
- Admin `api/shadowUse.ts`; a "Disputes" section on the ZM Component Requests page or the ticket drawer.
- Tests: `shadow-use-*`, `recovery-receipt-unable`, `warehouse-stock` e2e; admin test.

## Acceptance criteria

- [x] AC1 — a dispute restores exactly the decremented quantity, with a ledger row.
- [x] AC2 — a warehouse receipt writes a ledger row (+ stock only when a mapping exists).
- [x] AC3 — a ZM lists own-zone disputes with reason and escalation metadata.
- [x] AC4 — the WM guard is unchanged (ZM/CSM/SE still 403 on WM writes).

## Verification

`shadow-use-*`, `recovery-receipt-unable`, `warehouse-stock` e2e and the admin test (the tests the
plan names).

## UI surfaces

Admin: Component Requests page (ZM) or Ticket detail drawer — "Disputes" section (new section on an
existing page).

## Reference

- `docs/ui/desktop/v2-reference/19-shadow-use-queue.png`
- `docs/ui/desktop/v2-reference/18-component-requests.png`

## Blocked by

- #352 — consumption must exist before there is anything to dispute or restore

## Absorbs / supersedes

- survey ids: INV-G1, INV-G2, INV-G5
- existing issues: — (none)

## Decisions recorded

- **INV-G2 — Which component (if any) does a recovered device increment?** Default assumed by the
  plan: transaction row only; warehouse stock unchanged unless a device→component mapping exists.
  Strategic HITL (business rule); does not block this wave.
  **Built to that default and still unanswered.** No mapping table exists; the only mapping the model
  can express is `devices.device_type` naming a `component_master` row, which nothing in today's
  catalogue does — so in practice a receipt writes a transaction row and moves no stock. Reversal is
  one function: `writeRecoveryReceipt` in `ticketing/recovery.service.ts`.

## Notes for the next reader

- The plan's three `file:line` citations were accurate. What it did not say is that **none of the
  three rows could be written into `inventory_transactions` as it stood** — component-grain, SE-keyed,
  `NOT NULL` on both, no device column, no lifecycle state for either new row. Hand-written migration
  `20260903150000_inventory_ledger_closure` (drift gate not run — cannot run on this box).
- `src/verification/verification.service.ts` needed a three-line type narrowing forced by the nullable
  columns; `AppRoutes.tsx` (role gate) and `components/shell/nav.ts` (one row) were the shared leaves
  the ZM surface could not work without.
