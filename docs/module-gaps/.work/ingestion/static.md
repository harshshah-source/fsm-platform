> **CAVEAT (measured 2026-09-02):** the `audit` column follows only ONE delegation hop — it reports "no" whenever the audit write sits in a shared private helper. Verified false-positive rates: scheduling 11/11, tickets 8/10, cross-zone 6/6, vouchers 0/0, ingestion 0/3. Error is one-directional (under-detects, never invents), so "yes" is trustworthy and every "no" must be checked at `file:line`. The `guard` column can be off by one decorator. Never infer a UI facade from skeleton.md "no data hook" — admin pages use `useEffect` + `apps/admin/src/api/`, not react-query.

# static facts — AutoPlant Ingestion & Device State (ingestion)
columns: guard = @Roles/@Public on the handler · audit = withAudit/record/auditLog.create in the reached service · status = writes a *status/state* field · tx = $transaction

| endpoint | file:line | guard | audit | status-write | tx |
|---|---|---|---|---|---|
| `GET /api/integration/health` | apps/backend/src/ingestion/autoplant/integration-health.controller.ts:17 | 'OPERATIONS_HEAD' | no | no | no |
| `POST /api/integration/sync-masters` | apps/backend/src/ingestion/autoplant/integration-sync.controller.ts:37 | (cls) 'OPERATIONS_HEAD' | no | yes | no |
| `POST /api/integration/run-pipeline` | apps/backend/src/ingestion/autoplant/integration-sync.controller.ts:44 | (cls) 'OPERATIONS_HEAD' | no | yes | no |
| `GET /api/snapshots/latest` | apps/backend/src/ingestion/snapshots.controller.ts:28 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | yes | no |
| `GET /api/snapshots/runs` | apps/backend/src/ingestion/snapshots.controller.ts:34 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | yes | no |
| `POST /api/snapshots/run` | apps/backend/src/ingestion/snapshots.controller.ts:48 | 'OPERATIONS_HEAD' | no | yes | no |
| `GET /api/devices` | apps/backend/src/devices/devices.controller.ts:52 | ...READ_ROLES | no | yes | no |
| `GET /api/devices/filter-options` | apps/backend/src/devices/devices.controller.ts:87 | ...READ_ROLES | no | no | no |
| `GET /api/devices/:deviceId` | apps/backend/src/devices/devices.controller.ts:93 | ...READ_ROLES | no | yes | no |
| `GET /api/devices/:deviceId/cycles` | apps/backend/src/devices/devices.controller.ts:103 | ...READ_ROLES | no | yes | no |
| `GET /api/devices/:deviceId/downtime-trend` | apps/backend/src/devices/devices.controller.ts:112 | ...READ_ROLES | no | no | no |
| `PATCH /api/devices/:deviceId/deal-type` | apps/backend/src/devices/devices.controller.ts:120 | 'OPERATIONS_HEAD' | yes | no | no |

**totals:** 12 endpoints · 0 with no @Roles at handler or class · 0 @Public · 3 write-verb endpoints with no audit write in the reached method

## prisma models plausibly owned (name match on module keywords)
_no model name matched the slug — surveyor must map by hand_

## spine edges owned by this module
| id | from | to | carrier | receiver | reverse | ev |
|---|---|---|---|---|---|---|
| E-01 | ingestion · Device · INACTIVE+eligible | tickets | in-process call `createForInactiveEligible()` | cron `telemetryTick` | deviceId, plantId, cycleId, tier | `/tickets` TicketsPage.tsx:1 · ZM | none — device returning ACTIVE does not close the Ticket | E2 `ingestion/autoplant/integration-sync.service.ts:165` · `integration-scheduler.service.ts:77` | tickets | PARTIAL — no reverse ⇒ S3 |
| E-25 | ingestion · Device · departed from master sync | tickets | in-process `DeviceDepartureService.reconcile` during master sync | cron `mastersTick` | deviceId, plantId, last seen, open ticket ids | *(blank — output is `stand-down-export.ts`, a file; no admin screen, `/build-health` shows only health)* | none | E2 `device-departure/device-departure.service.ts:137` · `ingestion/autoplant/master-sync.service.ts:7` · `device-departure/stand-down-export.ts:34` | tickets | BROKEN — S4 |

## env flags referenced in this module
- `AUTOPLANT_SNAPSHOT_CHUNK_SIZE`
- `AUTOPLANT_SOURCE_UTC_OFFSET_MIN`
- `PARTITION_MAINTENANCE_CRON`
- `PARTITION_MAINTENANCE_ENABLED`
