# skeleton — SE Management, Planner & Availability (engineers)
generated 2026-09-02 · 0 TEQ · source: gapscope.profile.json

## admin routes (declared)
- `/engineers` — AppRoutes.tsx:168
- `/engineers/manage` — AppRoutes.tsx:177
- `/engineers/planner` — AppRoutes.tsx:365
- `/leave-requests` — AppRoutes.tsx:338

## backend endpoints
### apps/backend/src/engineers/engineers.controller.ts  `@Controller('engineers')`
- `GET /api/engineers` → `list()` :108
- `GET /api/engineers/directory` → `directory()` :118
- `POST /api/engineers` → `create()` :124
- `PATCH /api/engineers/:seId` → `update()` :148
- `POST /api/engineers/:seId/status` → `setStatus()` :174
- `POST /api/engineers/:seId/coverage` → `addCoverage()` :186
- `DELETE /api/engineers/:seId/coverage/:coverageId` → `removeCoverage()` :197
- `GET /api/engineers/:seId` → `detail()` :212
- `POST /api/engineers/:seId/availability` → `setAvailability()` :223

### apps/backend/src/engineers/leave-request.controller.ts  `@Controller('leave-requests')`
- `POST /api/leave-requests` → `submit()` :48
- `GET /api/leave-requests` → `list()` :74
- `POST /api/leave-requests/:id/approve` → `approve()` :80
- `POST /api/leave-requests/:id/reject` → `reject()` :89

### apps/backend/src/engineers/me-availability.controller.ts  `@Controller('me/availability')`
- `GET /api/me/availability` → `list()` :18

### apps/backend/src/engineers/me-leave-requests.controller.ts  `@Controller('me/leave-requests')`
- `GET /api/me/leave-requests` → `list()` :17

### apps/backend/src/planner/se-planner.controller.ts  `@Controller('planner')`
- `GET /api/planner` → `list()` :35
- `GET /api/planner/plants` → `plants()` :46
- `POST /api/planner` → `create()` :54
- `DELETE /api/planner/:id` → `remove()` :70

## backend units (services / schedulers / jobs)
- `apps/backend/src/engineers/engineer-admin.service.ts` — class EngineerAdminService:102 · list():108 · createSe():118 · updateSe():163 · setActive():236 · addCoverage():256 · removeCoverage():290
- `apps/backend/src/engineers/engineers-query.service.ts` — class EngineersQueryService:92 · listForZone():99 · getDetail():145
- `apps/backend/src/engineers/leave-request.service.ts` — class LeaveRequestService:54 · submit():61 · approve():87 · reject():117 · listForZone():140 · listForSe():154
- `apps/backend/src/engineers/se-availability.service.ts` — class SeAvailabilityService:41 · currentStatus():59 · listWindows():71 · currentStatusMany():87 · setAvailability():118
- `apps/backend/src/planner/se-planner.service.ts` — class SePlannerService:41 · upsert():44 · list():63 · listPlants():81 · remove():90

## admin UI files
- `apps/admin/src/pages/engineers/LeaveRequestsPage.tsx` — 146 loc · **no data hook**
- `apps/admin/src/pages/engineers/SeManagementDirectoryPage.tsx` — 544 loc · **no data hook**
- `apps/admin/src/pages/engineers/SeManagementPage.tsx` — 358 loc · **no data hook**
- `apps/admin/src/pages/planner/PlannerPage.tsx` — 289 loc · **no data hook**

## admin api client calls (apps/admin/src/api)

## mobile screens
- `apps/mobile/src/availability/availabilityDisplay.ts` — 25 loc
- `apps/mobile/src/leave/leaveDisplay.ts` — 57 loc
- `apps/mobile/src/leave/LeaveRequestFormScreen.tsx` — 178 loc

## tests touching this module
- `apps/backend/test/engineers-availability-controller.e2e-spec.ts`
- `apps/backend/test/engineers-detail.e2e-spec.ts`
- `apps/backend/test/engineers-list.e2e-spec.ts`
- `apps/backend/test/seed-mock-engineers.e2e-spec.ts`
- `apps/backend/test/zone-engineers.e2e-spec.ts`
