> **CAVEAT (measured 2026-09-02):** the `audit` column follows only ONE delegation hop — it reports "no" whenever the audit write sits in a shared private helper. Verified false-positive rates: scheduling 11/11, tickets 8/10, cross-zone 6/6, vouchers 0/0, ingestion 0/3. Error is one-directional (under-detects, never invents), so "yes" is trustworthy and every "no" must be checked at `file:line`. The `guard` column can be off by one decorator. Never infer a UI facade from skeleton.md "no data hook" — admin pages use `useEffect` + `apps/admin/src/api/`, not react-query.

# static facts — Zone Dashboard Home (dashboard)
columns: guard = @Roles/@Public on the handler · audit = withAudit/record/auditLog.create in the reached service · status = writes a *status/state* field · tx = $transaction

| endpoint | file:line | guard | audit | status-write | tx |
|---|---|---|---|---|---|
| `GET /api/dashboard/zone-overview` | apps/backend/src/dashboard/dashboard.controller.ts:39 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | no | no |
| `GET /api/dashboard/company-plant-overview` | apps/backend/src/dashboard/dashboard.controller.ts:45 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | no | no |
| `GET /api/dashboard/zone-operations` | apps/backend/src/dashboard/dashboard.controller.ts:61 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | yes | no |
| `GET /api/dashboard/critical-queue` | apps/backend/src/dashboard/dashboard.controller.ts:71 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | yes | no |
| `GET /api/dashboard/action-required` | apps/backend/src/dashboard/dashboard.controller.ts:89 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | yes | no |
| `GET /api/dashboard/fleet-composition` | apps/backend/src/dashboard/dashboard.controller.ts:103 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | no | no |
| `GET /api/dashboard/fleet-summary` | apps/backend/src/dashboard/dashboard.controller.ts:110 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | no | no |
| `GET /api/dashboard/fleet-directory` | apps/backend/src/dashboard/dashboard.controller.ts:117 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | no | no |
| `GET /api/dashboard/activity-trend` | apps/backend/src/dashboard/dashboard.controller.ts:128 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | no | no |
| `GET /api/dashboard/operating-mode` | apps/backend/src/dashboard/operating-mode.controller.ts:26 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | ? | ? | ? |
| `POST /api/tickets/:id/soft-state` | apps/backend/src/soft-state/soft-state.controller.ts:34 | 'SERVICE_ENGINEER' | yes | no | yes |
| `POST /api/me/activity-ping` | apps/backend/src/soft-state/soft-state.controller.ts:60 | 'SERVICE_ENGINEER' | yes | no | yes |

**totals:** 12 endpoints · 0 with no @Roles at handler or class · 0 @Public · 0 write-verb endpoints with no audit write in the reached method

## prisma models plausibly owned (name match on module keywords)
_no model name matched the slug — surveyor must map by hand_

## spine edges owned by this module
| id | from | to | carrier | receiver | reverse | ev |
|---|---|---|---|---|---|---|
| E-07 | tickets · Ticket · SE en-route | dashboard | route `POST /api/tickets/:id/soft-state` + `/api/me/activity-ping` | SE tap | ticketId, soft state, lat/lng | `/` zone-operations · ZM | soft state expires | E2 `soft-state/soft-state.controller.ts:34,60` | dashboard | OK |

## env flags referenced in this module
_none_
