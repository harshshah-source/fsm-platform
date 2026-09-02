# skeleton — Components, Van Stock & Warehouse (inventory)
generated 2026-09-02 · 0 TEQ · source: gapscope.profile.json

## admin routes (declared)
- `/component-blocked` — AppRoutes.tsx:413
- `/component-requests` — AppRoutes.tsx:431
- `/warehouse/requests` — AppRoutes.tsx:422
- `/warehouse/shadow-use` — AppRoutes.tsx:450
- `/warehouse/recovery-receipt` — AppRoutes.tsx:441

## backend endpoints
### apps/backend/src/inventory/inventory.controller.ts  `@Controller('component-blocked')`
- `GET /api/component-blocked` → `list()` :26
- `GET /api/component-blocked/van-stock` → `vanStock()` :42

### apps/backend/src/inventory/shadow-use.controller.ts  `@Controller('warehouse/shadow-use')`
- `GET /api/warehouse/shadow-use` → `list()` :41
- `POST /api/warehouse/shadow-use/:id/reconcile` → `reconcile()` :47
- `POST /api/warehouse/shadow-use/:id/dispute` → `dispute()` :53

### apps/backend/src/inventory/warehouse-stock.controller.ts  `@Controller('inventory')`
- `GET /api/inventory/warehouse-stock` → `list()` :36
- `GET /api/inventory/warehouse-stock/fulfillment-sla` → `fulfillmentSla()` :42
- `PATCH /api/inventory/warehouse-stock` → `setStock()` :48

### apps/backend/src/component-request/component-request.controller.ts  `@Controller('component-requests')`
- `GET /api/component-requests` → `oversight()` :26
- `GET /api/component-requests/by-ticket/:ticketId` → `byTicket()` :36
- `POST /api/component-requests/:id/confirm-receipt` → `confirmReceipt()` :42
- `POST /api/component-requests/:id/confirm-resubmit` → `confirmResubmit()` :54

### apps/backend/src/component-request/me-component-requests.controller.ts  `@Controller('me/component-requests')`
- `GET /api/me/component-requests` → `list()` :17

### apps/backend/src/component-request/warehouse.controller.ts  `@Controller('warehouse/requests')`
- `GET /api/warehouse/requests` → `list()` :52
- `POST /api/warehouse/requests/:id/approve` → `approve()` :58
- `POST /api/warehouse/requests/:id/ship` → `ship()` :64
- `POST /api/warehouse/requests/:id/reject` → `reject()` :80

## backend units (services / schedulers / jobs)
- `apps/backend/src/inventory/inventory.service.ts` — class InventoryService:33 · vanStockFor():37 · commonKitStatus():51 · componentBlockedQueue():74 · recordComponentBlock():107 · resolveComponentBlock():128
- `apps/backend/src/inventory/shadow-use.service.ts` — class ShadowUseService:28 · queue():32 · markReconciled():55 · markDisputed():72
- `apps/backend/src/inventory/warehouse-stock.service.ts` — class WarehouseStockService:75 · listStock():82 · setStock():93 · fulfillmentSla():136
- `apps/backend/src/component-request/component-request.service.ts` — class ComponentRequestService:85 · queue():89 · oversightQueue():98 · byTicket():110 · bySe():127 · approve():147 · markShipped():157 · confirmReceipt():182 · reject():219 · confirmResubmit():240

## admin UI files
- `apps/admin/src/pages/warehouse/RecoveryReceiptQueuePage.tsx` — 89 loc · **no data hook**
- `apps/admin/src/pages/inventory/ComponentBlockedPage.tsx` — 116 loc · **no data hook**
- `apps/admin/src/pages/inventory/ComponentRequestsPage.tsx` — 209 loc · **no data hook**
- `apps/admin/src/pages/inventory/ShadowUseQueuePage.tsx` — 141 loc · **no data hook**

## admin api client calls (apps/admin/src/api)

## mobile screens
- `apps/mobile/src/stock/vanStockDisplay.ts` — 45 loc

## tests touching this module
- `apps/backend/test/inventory-rollback.e2e-spec.ts`
- `apps/backend/test/inventory-schema.e2e-spec.ts`
- `apps/backend/test/inventory-service.e2e-spec.ts`
- `apps/backend/test/inventory-transactions-schema.e2e-spec.ts`
