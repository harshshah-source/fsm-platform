# skeleton — Intra-day Re-plan Queue (intraday)
generated 2026-09-02 · 0 TEQ · source: gapscope.profile.json

## admin routes (declared)
- `/intraday` — AppRoutes.tsx:375

## backend endpoints
### apps/backend/src/intraday/intraday-insertion.controller.ts  `@Controller('intraday-insertions')`
- `GET /api/intraday-insertions` → `list()` :44
- `POST /api/intraday-insertions/fire` → `fire()` :51
- `GET /api/intraday-insertions/:id/available-ses` → `availableSes()` :71
- `POST /api/intraday-insertions/:id/manual-assign` → `manualAssign()` :79

## backend units (services / schedulers / jobs)
- `apps/backend/src/intraday/current-assignee.ts` — if():31 · for():47
- `apps/backend/src/intraday/intraday-insertion.service.ts` — class IntradayInsertionService:147 · assignCriticalForZone():172 · assignCriticalForActiveZones():359 · availableSesForManualAssign():400 · manualAssign():413 · listForScope():478
- `apps/backend/src/intraday/stranded-work-escalation.service.ts` — class StrandedWorkEscalationService:37 · escalateStrandedWork():57

## admin UI files

## admin api client calls (apps/admin/src/api)

## mobile screens
_no mobile surface declared for this module_

## tests touching this module
- `apps/backend/test/business-sweep-scheduler-intraday.e2e-spec.ts`
- `apps/backend/test/intraday-critical-insertion.e2e-spec.ts`
- `apps/backend/test/intraday-insertions-controller.e2e-spec.ts`
- `apps/backend/test/intraday-ledger-atomicity.e2e-spec.ts`
- `apps/backend/test/intraday-updates-controller.e2e-spec.ts`
