> **CAVEAT (measured 2026-09-02):** the `audit` column follows only ONE delegation hop — it reports "no" whenever the audit write sits in a shared private helper. Verified false-positive rates: scheduling 11/11, tickets 8/10, cross-zone 6/6, vouchers 0/0, ingestion 0/3. Error is one-directional (under-detects, never invents), so "yes" is trustworthy and every "no" must be checked at `file:line`. The `guard` column can be off by one decorator. Never infer a UI facade from skeleton.md "no data hook" — admin pages use `useEffect` + `apps/admin/src/api/`, not react-query.

# static facts — Cross-Zone Escalation (cross-zone)
columns: guard = @Roles/@Public on the handler · audit = withAudit/record/auditLog.create in the reached service · status = writes a *status/state* field · tx = $transaction

| endpoint | file:line | guard | audit | status-write | tx |
|---|---|---|---|---|---|
| `GET /api/cross-zone` | apps/backend/src/cross-zone/cross-zone.controller.ts:41 | ...ALL_MANAGERS | no | yes | no |
| `POST /api/cross-zone/sweep` | apps/backend/src/cross-zone/cross-zone.controller.ts:47 | ...ALL_MANAGERS | no | yes | no |
| `POST /api/cross-zone/flag` | apps/backend/src/cross-zone/cross-zone.controller.ts:54 | ...CROSS_ZONE_DECIDERS | no | yes | no |
| `POST /api/cross-zone/:id/approve` | apps/backend/src/cross-zone/cross-zone.controller.ts:69 | ...CROSS_ZONE_DECIDERS | no | yes | no |
| `POST /api/cross-zone/:id/deny` | apps/backend/src/cross-zone/cross-zone.controller.ts:81 | ...CROSS_ZONE_DECIDERS | no | yes | no |
| `POST /api/cross-zone/:id/defer` | apps/backend/src/cross-zone/cross-zone.controller.ts:89 | ...CROSS_ZONE_DECIDERS | no | yes | no |
| `POST /api/cross-zone/:id/re-escalate` | apps/backend/src/cross-zone/cross-zone.controller.ts:101 | 'ZONAL_MANAGER' | no | yes | no |

**totals:** 7 endpoints · 0 with no @Roles at handler or class · 0 @Public · 6 write-verb endpoints with no audit write in the reached method

## prisma models plausibly owned (name match on module keywords)
- `Zone :324`
- `CrossZoneEscalation :589`
- `DispatchRunZone :892`
- `DispatchZoneRecovery :962`
- `ZoneWarehouseStock :1339`
- `ZoneMapping :2158`
- `PlantZoneOverride :2184`

## spine edges owned by this module
| id | from | to | carrier | receiver | reverse | ev |
|---|---|---|---|---|---|---|
| E-23 | scheduling · Ticket · unassignable in home zone | cross-zone | cron sweep `sweepAutoEscalations` | cron `crossZoneTick` | ticketId, homeZoneId, tier, age | `/cross-zone` CrossZonePage.tsx · CSM/OH | `deny` :81 → `re-escalate` :101 · `defer` :89 | E2 `cross-zone/cross-zone-escalation.service.ts:74` · `scheduling/business-sweep-scheduler.service.ts:236` | cross-zone | OK |
| E-24 | cross-zone · Escalation · APPROVED | scheduling | in-process `override.assignTicket(..., 'CROSS_ZONE_ASSIGN')` + `notifyHomeZm` | CSM/OH click | ticketId, targetZoneId, seId, scheduleId, batchId | home ZM notified; **target-zone SE relies on E-05's broken push** | `deny`/`defer` leave the ticket in home queue | E2 `cross-zone/cross-zone-escalation.service.ts:150-180` | scheduling | PARTIAL — S3 |

## env flags referenced in this module
_none_
