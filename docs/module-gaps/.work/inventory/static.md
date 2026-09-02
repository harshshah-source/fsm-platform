> **CAVEAT (measured 2026-09-02):** the `audit` column follows only ONE delegation hop — it reports "no" whenever the audit write sits in a shared private helper. Verified false-positive rates: scheduling 11/11, tickets 8/10, cross-zone 6/6, vouchers 0/0, ingestion 0/3. Error is one-directional (under-detects, never invents), so "yes" is trustworthy and every "no" must be checked at `file:line`. The `guard` column can be off by one decorator. Never infer a UI facade from skeleton.md "no data hook" — admin pages use `useEffect` + `apps/admin/src/api/`, not react-query.

# static facts — Components, Van Stock & Warehouse (inventory)
columns: guard = @Roles/@Public on the handler · audit = withAudit/record/auditLog.create in the reached service · status = writes a *status/state* field · tx = $transaction

| endpoint | file:line | guard | audit | status-write | tx |
|---|---|---|---|---|---|
| `GET /api/component-blocked` | apps/backend/src/inventory/inventory.controller.ts:26 | ...MANAGER_ROLES | no | yes | no |
| `GET /api/component-blocked/van-stock` | apps/backend/src/inventory/inventory.controller.ts:42 | 'SERVICE_ENGINEER' | no | yes | no |
| `GET /api/warehouse/shadow-use` | apps/backend/src/inventory/shadow-use.controller.ts:41 | 'WAREHOUSE_MANAGER' | yes | yes | yes |
| `POST /api/warehouse/shadow-use/:id/reconcile` | apps/backend/src/inventory/shadow-use.controller.ts:47 | 'WAREHOUSE_MANAGER' | yes | yes | yes |
| `POST /api/warehouse/shadow-use/:id/dispute` | apps/backend/src/inventory/shadow-use.controller.ts:53 | 'WAREHOUSE_MANAGER' | yes | yes | yes |
| `GET /api/inventory/warehouse-stock` | apps/backend/src/inventory/warehouse-stock.controller.ts:36 | ...READ_ROLES | yes | yes | no |
| `GET /api/inventory/warehouse-stock/fulfillment-sla` | apps/backend/src/inventory/warehouse-stock.controller.ts:42 | ...READ_ROLES | no | yes | no |
| `PATCH /api/inventory/warehouse-stock` | apps/backend/src/inventory/warehouse-stock.controller.ts:48 | ...READ_ROLES | yes | yes | no |
| `GET /api/component-requests` | apps/backend/src/component-request/component-request.controller.ts:26 | ...MANAGER_ROLES | no | yes | no |
| `GET /api/component-requests/by-ticket/:ticketId` | apps/backend/src/component-request/component-request.controller.ts:36 | ...MANAGER_ROLES | no | yes | yes |
| `POST /api/component-requests/:id/confirm-receipt` | apps/backend/src/component-request/component-request.controller.ts:42 | ...MANAGER_ROLES | yes | yes | yes |
| `POST /api/component-requests/:id/confirm-resubmit` | apps/backend/src/component-request/component-request.controller.ts:54 | ...MANAGER_ROLES | yes | yes | yes |
| `GET /api/me/component-requests` | apps/backend/src/component-request/me-component-requests.controller.ts:17 | 'SERVICE_ENGINEER' | yes | yes | yes |
| `GET /api/warehouse/requests` | apps/backend/src/component-request/warehouse.controller.ts:52 | 'WAREHOUSE_MANAGER' | yes | yes | yes |
| `POST /api/warehouse/requests/:id/approve` | apps/backend/src/component-request/warehouse.controller.ts:58 | 'WAREHOUSE_MANAGER' | yes | yes | yes |
| `POST /api/warehouse/requests/:id/ship` | apps/backend/src/component-request/warehouse.controller.ts:64 | 'WAREHOUSE_MANAGER' | yes | yes | yes |
| `POST /api/warehouse/requests/:id/reject` | apps/backend/src/component-request/warehouse.controller.ts:80 | 'WAREHOUSE_MANAGER' | yes | yes | yes |

**totals:** 17 endpoints · 0 with no @Roles at handler or class · 0 @Public · 0 write-verb endpoints with no audit write in the reached method

## prisma models plausibly owned (name match on module keywords)
- `InventoryTransaction :1446`

## spine edges owned by this module
| id | from | to | carrier | receiver | reverse | ev |
|---|---|---|---|---|---|---|
| E-11 | tickets · Consumed components · PRE_VERIFICATION | inventory | status flip — `InventoryTransaction` + `ComponentRequest` created in submit tx | SE submit | seId, componentId, qty, ticketId, submissionId | `/warehouse/requests` (WM) + `/component-requests` (ZM) | `POST /warehouse/requests/:id/reject` :80 | E2 `ticketing/troubleshoot-submission.service.ts:225,300-307` · `component-request/warehouse.controller.ts:52` | inventory | OK |
| E-12 | inventory · ComponentRequest · SHIPPED | tickets (mobile) | route `GET /api/me/component-requests` exists | WM click ship | requestId, componentId, qty, courier, ETA | **blank — no mobile screen consumes it** (mobile/stock has only vanStockDisplay.ts + StockScreen.tsx) | `confirm-receipt` :42 is ZM-only, not SE | E2 `component-request/me-component-requests.controller.ts:17` · `component-request/warehouse.controller.ts:64` · mobile `navigation/SeTabShell.tsx:66-70` | tickets | BROKEN — S4 |
| E-13 | inventory · ComponentRequest · REJECTED | inventory | route `POST /component-requests/:id/confirm-resubmit` | ZM click | requestId, reject reason | `/component-requests` ComponentRequestsPage.tsx · ZM | resubmit is itself the reverse | E2 `component-request/component-request.controller.ts:54` | inventory | OK |
| E-14 | tickets · Losing SE's stock · SHADOW_USE | inventory | status flip inside 409 handler; van stock decremented | business-409 on submit | seId, componentId, qty, ticketId, winnerSeId | `/warehouse/shadow-use` ShadowUseQueuePage.tsx · WM | `POST /shadow-use/:id/dispute` :53 flips status but **never restores the decremented van stock** | E2 `ticketing/troubleshoot-submission.service.ts:329-360` · `inventory/shadow-use.controller.ts:53` · `inventory/shadow-use.service.ts:72` | inventory | BROKEN — S4 + DANGEROUS (stock/financial) |
| E-27 | tickets · Recovery · COLLECTED by SE | inventory | status flip → `GET /api/recovery/awaiting-receipt` worklist | SE `POST /recovery/:id/collected` :57 | ticketId, deviceId, seId, collected at | `/warehouse/recovery-receipt` RecoveryReceiptQueuePage.tsx · WM | `unable-to-collect` :70 → `reschedule` :113 / `close-failed` :121 / `escalate` :128 | E2 `ticketing/recovery.controller.ts:57,70,78,85` | inventory | OK |

## env flags referenced in this module
_none_
