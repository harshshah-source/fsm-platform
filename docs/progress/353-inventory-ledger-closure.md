# 353 — Inventory ledger closure: dispute restore, recovery receipt, ZM dispute view

**Done 2026-09-03.** Wave 3 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids INV-G1, INV-G2, INV-G5.
Red-first. Depends on #352 (consumption must exist before there is anything to dispute), closed.

## What it closes

Three places where the inventory ledger stopped short of the truth, and each of them was a one-way
door: the number went wrong and nothing downstream ever noticed.

1. **A dispute never gave the part back.** `markDisputed` flipped SHADOW_USE → DISPUTED, wrote an
   audit row and told the ZM. The component the losing SE had physically put in a machine stayed
   charged against their van **forever**. `verification.service.ts` had compensated a failed
   verification the same way since Issue 24 — the dispute path simply never did, so ledger and shelf
   disagreed permanently and only a physical count would find it.
2. **A recovered device came back with no receipt.** `confirmWarehouseReceipt` closed the ticket and
   wrote nothing to inventory. "The device is in the warehouse" was a ticket status and not a fact
   any stock reader could see: a recovered device and a lost one looked identical.
3. **The ZM a dispute is "escalated to" could not see it.** The Shadow Use routes were
   WAREHOUSE_MANAGER-only, so the escalation went into an audit row and the queue was adjudicated by
   whoever happened to look. The admin route was WM-only too, and the sidebar offered a ZM no link.

## Where the issue's premise was right, and the one place it was short

The three `file:line` citations were all accurate against the working tree. What the plan did not say
is that **none of the three could be written into `inventory_transactions` as it stood**: the table is
component-grain and SE-keyed (`se_id` and `component_id` both `NOT NULL`, no device column), and the
lifecycle enum has no state for either new row. "Write a `RECOVERY_RECEIPT` row keyed by device" is a
migration, not a service change. So this slice hand-writes one
(`20260903150000_inventory_ledger_closure`) — see *Migration* below.

## The shape of the fix

**Dispute (AC1).** `markDisputed` now, inside the transaction that already flips the status:
increments `se_van_stock` by exactly the disputed quantity and writes a
`SHADOW_USE_DISPUTE_RESTORE` ledger row carrying the same SE, component, qty, ticket and reason. The
audit metadata gains `restoredQty`. The DISPUTED row itself is untouched — it is the WM's decision and
the ZM's queue — which is why the restore is a **second row** rather than a status change on the first
(the difference from verification's `ROLLED_BACK`, which has no decision to preserve).

**Receipt (AC2).** `confirmWarehouseReceipt` writes a `RECOVERY_RECEIPT` row keyed by `device_id`,
qty 1, `type = FAULTY_COMPONENT_RETURNED`, `reason` = the SE's collection condition notes, in the same
`withAudit` transaction as the two closure legs — so a rolled-back receipt leaves no receipt (pinned
by the existing #338 enqueue-failure test).

**ZM view (AC3).** `GET /warehouse/shadow-use?status=DISPUTED` opens the **read** to ZM / CSM / OH.
The service takes a `ManagerScope` and clamps a ZM through ticket → plant → zone. Rows come back with
`escalatedTo` / `escalatedBy` / `escalatedAt`. On the admin side the same page renders a **Disputes**
section for both audiences; a manager sees that section alone.

**The WM guard (AC4) is untouched.** Both POSTs stay `@Roles('WAREHOUSE_MANAGER')`; a ZM gets 403 on
each, and an SE still gets 403 on the read.

## Decisions worth keeping

**1. INV-G2 — assumed default: a recovery receipt writes a transaction row and moves no stock.**
This is the operator decision the plan flagged, and it is **still unanswered**; the default is
recorded here so it is cheap to reverse. The data model has **no device→component mapping table**, and
the only mapping it can express is `devices.device_type` naming a row in `component_master`. So
`writeRecoveryReceipt` looks that up: unmapped (every device in today's catalogue) the row is written
and `zone_warehouse_stock` is untouched; mapped, the ticket's plant's zone is incremented by 1 so a
zone that genuinely stocks the recovered device as a SKU gets a level that matches its shelf.
**If the operator decides a recovery must never touch warehouse stock, the reversal is that one
function: delete the lookup and the increment.** Nothing else reads the mapping.

**2. `se_id` and `component_id` become nullable, and a `device_id` column appears — with a CHECK.**
A device arriving at a warehouse belongs to no engineer's van and is not necessarily a catalogued SKU;
forcing either would put fiction in the ledger. The widening is bounded by
`inventory_transactions_keyed`: `se_id IS NOT NULL OR device_id IS NOT NULL`. A ledger row accounts
for an engineer's stock or for a device, never for neither.

**3. The receipt records the collector only when the collector is an engineer.**
`tickets.assigned_se_id` is a bare uuid with no FK; `inventory_transactions.se_id` has one to
`engineer_master`. Writing the assignee blind would turn a receipt the Warehouse Manager has already
physically performed into a 500 the first time an assignee is not an engineer row. So the lookup is
explicit and a miss leaves the column null, with the device still keying the row. This is not
hypothetical — it is exactly what `recovery-receipt-unable`'s old `11111111-…` SE turned out to be,
which is why that spec now uses the shared auth SE (`SHARED_AUTH_SE_ID`) and the attribution is
asserted for real.

**4. `incrementWarehouseStock` is a function taking a transaction client, not a service method.**
`setStock` writes an **absolute** count, which is the wrong shape for something arriving: two receipts
landing on one level must add rather than overwrite, and the first arrival of a SKU a zone has never
held must open the row rather than 404. Its caller — a warehouse receipt — already owns a commit the
movement belongs inside (device received, ticket closed, level raised: one fact or none), so it takes
the caller's `tx` and stays a pure arithmetic primitive. Audit rides on the caller's audited write:
`RECOVERY_RECEIVED_AND_CLOSED` metadata now carries `receipt: { componentId, stockIncremented }`,
filled in by the transaction body so the audit says what the ledger *did*, not what it planned.

**5. A non-WM manager reads DISPUTED and nothing else, and an unknown filter is a 400.** The
unreconciled queue is the Warehouse Manager's work; a manager asking for it would be reading someone
else's inbox. And a typo'd status that silently returns the unreconciled queue is worse than an
error — `readStatus` in the controller is where both rules live.

**6. The Disputes section shows "Qty restored", not "Qty".** The restore is guaranteed and in the
same transaction, so by the time a ZM sees the row the ledger already balances. Naming the column that
way says what the ZM is actually being asked to do: adjudicate who was right, not chase a correction
that still has to be made.

## Migration

`apps/backend/prisma/migrations/20260903150000_inventory_ledger_closure/migration.sql`, hand-written
per the standing operator decision. Two `ALTER TYPE … ADD VALUE IF NOT EXISTS` on
`inventory_txn_status`, two `DROP NOT NULL`, the `device_id` column + FK + index, and the
`inventory_transactions_keyed` CHECK. **The Prisma drift gate was not run** — it cannot run on this
box (the local `fsm` role cannot `CREATE DATABASE`); `prisma/drift-baseline.txt` is untouched. The
suite is the check: `migrate deploy` applies it in `test/global-setup.ts` on every run.

## Acceptance criteria

- **AC1 — a dispute restores exactly the decremented quantity, with a ledger row.** ✅
  `se_van_stock` +qty and a `SHADOW_USE_DISPUTE_RESTORE` row, both inside the dispute's transaction;
  the restore row is excluded from the WM's queue.
- **AC2 — a warehouse receipt writes a ledger row (+ stock only when a mapping exists).** ✅
  Device-keyed `RECOVERY_RECEIPT` row on every receipt; `zone_warehouse_stock` moves only on the
  mapped branch, and two mapped receipts add rather than overwrite.
- **AC3 — a ZM lists own-zone disputes with reason and escalation metadata.** ✅ Service-level
  zone clamp, HTTP surface, and the admin Disputes section.
- **AC4 — the WM guard is unchanged (ZM/CSM/SE still 403 on WM writes).** ✅ Asserted directly in
  `shadow-use-controller`.

## What was tested, and why in that shape

The two ledger ACs are **arithmetic**, so they are tested as arithmetic: read the level, act, read it
again. Nothing about them is observable from a status or an audit row, which is precisely how they
stayed broken.

- `shadow-use-queue.e2e-spec.ts` (6) — the restore, at the service seam where the compensation lives:
  van stock exactly +qty, the compensating row present with the same SE/component, and the restore row
  **absent from the queue** (bookkeeping is not new work). Plus the ZM read: own-zone dispute with
  reason + escalation metadata, and a foreign zone that returns nothing.
- `shadow-use-controller.e2e-spec.ts` (3) — the HTTP contract: a ZM reads `?status=DISPUTED` and gets
  the reason and `escalatedTo`; the same ZM gets **403 on both writes**; an SE still gets 403 on the
  read; an unknown status is a 400.
- `recovery-receipt-unable.e2e-spec.ts` (9) — the receipt row's shape (device, null component, qty 1,
  collector), that an unmapped receipt leaves `zone_warehouse_stock` **byte-identical**, that a mapped
  one increments and a second one adds, and — folded into #338's existing rollback case — that a
  failed notification enqueue leaves **no** receipt row behind.
- `warehouse-stock.e2e-spec.ts` (6) — `incrementWarehouseStock` creating from zero, adding to an
  existing level, and honouring the caller's rollback.
- `apps/admin/test/shadow-use-queue.test.tsx` (5) — a ZM sees the Disputes table with the reason and
  no WM actions and never asks for the unreconciled queue; a WM sees both tables and the Disputed
  metric.

Verbatim:

```
# the slice's four specs
 Test Files  4 passed (4)
      Tests  24 passed (24)

# regression: inventory / verification / troubleshoot / recovery / the two route sweeps
 Test Files  1 failed | 9 passed (11)      ← recovery-controller, afterAll only (see below)
      Tests  53 passed (58)

# after the teardown fix — recovery-controller, closure-clears-assignment,
# recovery-compliance-stalled, recovery-decision-controller, recovery-notifier-spine
 Test Files  5 passed (5)
      Tests  19 passed (19)

# admin
 test/shadow-use-queue.test.tsx                          5 passed (5)
 sidebar-shell + dispatch-timeline-nav + dashboard-warehouse + ui-shell-density
 Test Files  4 passed (4)
      Tests  22 passed (22)
```

Two existing specs needed a teardown line, not a behaviour change: a receipt now leaves an
`inventory_transactions` row whose ticket and device FKs are `RESTRICT`, so
`recovery-controller.e2e-spec.ts` and `closure-clears-assignment.e2e-spec.ts` delete the ledger row
before the ticket. Both failed in `afterAll` with every assertion passing — worth knowing, because
that failure mode reads as a broken test file rather than a new FK.

## Follow-ups this slice does not own

- **INV-G2 is still an open operator decision.** The default above is assumed, not answered.
- **No device→component mapping exists as data.** `device_type`-names-a-component is the only mapping
  the model can express. A real mapping (SKU per device model) is a backlog item, not this slice.
- **The reference-19 status filter** (`All statuses` dropdown + result count) is not built. The status
  parameter it needs exists on the API and the three metric cards it sits under are now filled; the
  control itself is cosmetic and outside these ACs.
- **Reconciliation on the ZM side.** A ZM can now *read* a dispute; adjudicating it (upholding or
  overturning, with an outcome that writes back) is not in this slice's ACs and has no endpoint.

## Files touched

Backend: `prisma/schema.prisma`, `prisma/migrations/20260903150000_inventory_ledger_closure/`,
`src/inventory/shadow-use.service.ts`, `src/inventory/shadow-use.controller.ts`,
`src/inventory/warehouse-stock.service.ts`, `src/ticketing/recovery.service.ts`,
`src/verification/verification.service.ts` (type narrowing forced by the nullable columns).
Admin: `src/api/shadowUse.ts`, `src/pages/inventory/ShadowUseQueuePage.tsx`, `src/AppRoutes.tsx`
(role gate), `src/components/shell/nav.ts` (one nav row).
Tests: the four backend specs above, `test/recovery-controller.e2e-spec.ts` and
`test/closure-clears-assignment.e2e-spec.ts` (teardown only), + `apps/admin/test/shadow-use-queue.test.tsx`.
