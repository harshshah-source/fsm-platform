> **CAVEAT (measured 2026-09-02):** the `audit` column follows only ONE delegation hop — it reports "no" whenever the audit write sits in a shared private helper. Verified false-positive rates: scheduling 11/11, tickets 8/10, cross-zone 6/6, vouchers 0/0, ingestion 0/3. Error is one-directional (under-detects, never invents), so "yes" is trustworthy and every "no" must be checked at `file:line`. The `guard` column can be off by one decorator. Never infer a UI facade from skeleton.md "no data hook" — admin pages use `useEffect` + `apps/admin/src/api/`, not react-query.

# static facts — SE Management, Planner & Availability (engineers)
columns: guard = @Roles/@Public on the handler · audit = withAudit/record/auditLog.create in the reached service · status = writes a *status/state* field · tx = $transaction

| endpoint | file:line | guard | audit | status-write | tx |
|---|---|---|---|---|---|
| `GET /api/engineers` | apps/backend/src/engineers/engineers.controller.ts:108 | ...MANAGER_ROLES | no | yes | no |
| `GET /api/engineers/directory` | apps/backend/src/engineers/engineers.controller.ts:118 | ...MANAGER_ROLES | yes | yes | no |
| `POST /api/engineers` | apps/backend/src/engineers/engineers.controller.ts:124 | ...MANAGER_ROLES | yes | yes | no |
| `PATCH /api/engineers/:seId` | apps/backend/src/engineers/engineers.controller.ts:148 | ...MANAGER_ROLES | yes | yes | no |
| `POST /api/engineers/:seId/status` | apps/backend/src/engineers/engineers.controller.ts:174 | ...MANAGER_ROLES | yes | yes | no |
| `POST /api/engineers/:seId/coverage` | apps/backend/src/engineers/engineers.controller.ts:186 | ...MANAGER_ROLES | yes | no | no |
| `DELETE /api/engineers/:seId/coverage/:coverageId` | apps/backend/src/engineers/engineers.controller.ts:197 | ...MANAGER_ROLES | yes | no | no |
| `GET /api/engineers/:seId` | apps/backend/src/engineers/engineers.controller.ts:212 | ...MANAGER_ROLES | no | yes | no |
| `POST /api/engineers/:seId/availability` | apps/backend/src/engineers/engineers.controller.ts:223 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','SERVICE_ENGINEER' | yes | yes | yes |
| `POST /api/leave-requests` | apps/backend/src/engineers/leave-request.controller.ts:48 | 'SERVICE_ENGINEER','ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER' | no | yes | no |
| `GET /api/leave-requests` | apps/backend/src/engineers/leave-request.controller.ts:74 | ...MANAGER_ROLES | no | yes | no |
| `POST /api/leave-requests/:id/approve` | apps/backend/src/engineers/leave-request.controller.ts:80 | ...MANAGER_ROLES | no | yes | no |
| `POST /api/leave-requests/:id/reject` | apps/backend/src/engineers/leave-request.controller.ts:89 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER' | no | yes | no |
| `GET /api/me/availability` | apps/backend/src/engineers/me-availability.controller.ts:18 | 'SERVICE_ENGINEER' | yes | yes | yes |
| `GET /api/me/leave-requests` | apps/backend/src/engineers/me-leave-requests.controller.ts:17 | 'SERVICE_ENGINEER' | no | yes | no |
| `GET /api/planner` | apps/backend/src/planner/se-planner.controller.ts:35 | ...MANAGER_ROLES | yes | yes | no |
| `GET /api/planner/plants` | apps/backend/src/planner/se-planner.controller.ts:46 | ...MANAGER_ROLES | no | no | no |
| `POST /api/planner` | apps/backend/src/planner/se-planner.controller.ts:54 | ...MANAGER_ROLES | no | no | no |
| `DELETE /api/planner/:id` | apps/backend/src/planner/se-planner.controller.ts:70 | ...MANAGER_ROLES | no | no | no |

**totals:** 19 endpoints · 0 with no @Roles at handler or class · 0 @Public · 5 write-verb endpoints with no audit write in the reached method

## prisma models plausibly owned (name match on module keywords)
_no model name matched the slug — surveyor must map by hand_

## spine edges owned by this module
_SPINE.md exists but names no edge for this module_

## env flags referenced in this module
_none_
