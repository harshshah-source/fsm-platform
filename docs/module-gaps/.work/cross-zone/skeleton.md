# skeleton — Cross-Zone Escalation (cross-zone)
generated 2026-09-02 · 0 TEQ · source: gapscope.profile.json

## admin routes (declared)
- `/cross-zone` — AppRoutes.tsx:347
- `/tier-overrides` — AppRoutes.tsx:288

## backend endpoints
### apps/backend/src/cross-zone/cross-zone.controller.ts  `@Controller('cross-zone')`
- `GET /api/cross-zone` → `list()` :41
- `POST /api/cross-zone/sweep` → `sweep()` :47
- `POST /api/cross-zone/flag` → `flag()` :54
- `POST /api/cross-zone/:id/approve` → `approve()` :69
- `POST /api/cross-zone/:id/deny` → `deny()` :81
- `POST /api/cross-zone/:id/defer` → `defer()` :89
- `POST /api/cross-zone/:id/re-escalate` → `reEscalate()` :101

## backend units (services / schedulers / jobs)
- `apps/backend/src/cross-zone/cross-zone-escalation.service.ts` — class CrossZoneEscalationService:65 · sweepAutoEscalations():74 · flag():121 · approve():150 · deny():185 · defer():190 · reEscalateToOps():201 · listForScope():223
- `apps/backend/src/cross-zone/cross-zone.dtos.ts` — class SweepBody:19 · class FlagBody:27 · class ApproveBody:37 · class DenyBody:49 · class DeferBody:55

## admin UI files
- `apps/admin/src/pages/cross-zone/CrossZonePage.tsx` — 172 loc · **no data hook**

## admin api client calls (apps/admin/src/api)

## mobile screens
_no mobile surface declared for this module_

## tests touching this module
- `apps/backend/test/autoplant-state-map-zone-resolver.spec.ts`
- `apps/backend/test/autoplant-state-zone-map.spec.ts`
- `apps/backend/test/cross-zone-controller.e2e-spec.ts`
- `apps/backend/test/cross-zone-escalation.e2e-spec.ts`
- `apps/backend/test/dashboard-zone-drilldown.e2e-spec.ts`
- `apps/backend/test/dashboard-zone-overview.e2e-spec.ts`
- `apps/backend/test/dispatch-crashed-zone-recovery.e2e-spec.ts`
- `apps/backend/test/dispatch-errored-zone-recovery.e2e-spec.ts`
- `apps/backend/test/dispatch-heartbeat-in-zone.e2e-spec.ts`
- `apps/backend/test/dispatch-run-zone-clamp.e2e-spec.ts`
- `apps/backend/test/dispatch-run-zone-scoped.e2e-spec.ts`
- `apps/backend/test/dispatch-zone-claim-admission.e2e-spec.ts`
- `apps/backend/test/dispatch-zone-wedge.e2e-spec.ts`
- `apps/backend/test/install-lifecycle-zone-scope.e2e-spec.ts`
- `apps/backend/test/org-plants-zone-view.e2e-spec.ts`
- `apps/backend/test/org-zones.e2e-spec.ts`
- `apps/backend/test/per-zone-zm-logins.e2e-spec.ts`
- `apps/backend/test/plant-zone-change-downstream.e2e-spec.ts`
- `apps/backend/test/plant-zone-change-impact.e2e-spec.ts`
- `apps/backend/test/plant-zone-override-audit.e2e-spec.ts`
- `apps/backend/test/prisma-session-timezone.spec.ts`
- `apps/backend/test/recommender-cross-zone-capacity.e2e-spec.ts`
- `apps/backend/test/zone-engineers.e2e-spec.ts`
- `apps/backend/test/zone-mapping-normalize.spec.ts`
- `apps/backend/test/zone-mapping-resolver.e2e-spec.ts`
- `apps/backend/test/zone-plants.e2e-spec.ts`
- `apps/backend/test/zone-scope.e2e-spec.ts`
