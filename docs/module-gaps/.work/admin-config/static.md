> **CAVEAT (measured 2026-09-02):** the `audit` column follows only ONE delegation hop — it reports "no" whenever the audit write sits in a shared private helper. Verified false-positive rates: scheduling 11/11, tickets 8/10, cross-zone 6/6, vouchers 0/0, ingestion 0/3. Error is one-directional (under-detects, never invents), so "yes" is trustworthy and every "no" must be checked at `file:line`. The `guard` column can be off by one decorator. Never infer a UI facade from skeleton.md "no data hook" — admin pages use `useEffect` + `apps/admin/src/api/`, not react-query.

# static facts — Settings, Org Config & Ops Explorer (admin-config)
columns: guard = @Roles/@Public on the handler · audit = withAudit/record/auditLog.create in the reached service · status = writes a *status/state* field · tx = $transaction

| endpoint | file:line | guard | audit | status-write | tx |
|---|---|---|---|---|---|
| `GET /api/org/common-kit` | apps/backend/src/org/common-kit.controller.ts:20 | 'OPERATIONS_HEAD' | yes | no | no |
| `POST /api/org/common-kit` | apps/backend/src/org/common-kit.controller.ts:25 | (cls) 'OPERATIONS_HEAD' | yes | no | no |
| `GET /api/org/companies` | apps/backend/src/org/companies.controller.ts:24 | 'OPERATIONS_HEAD' | yes | no | no |
| `POST /api/org/companies` | apps/backend/src/org/companies.controller.ts:29 | (cls) 'OPERATIONS_HEAD' | yes | no | no |
| `PATCH /api/org/companies/:id` | apps/backend/src/org/companies.controller.ts:37 | (cls) 'OPERATIONS_HEAD' | yes | no | no |
| `GET /api/org/geo/states` | apps/backend/src/org/geography.controller.ts:16 | **none** | no | yes | no |
| `GET /api/org/geo/regions` | apps/backend/src/org/geography.controller.ts:21 | **none** | no | yes | no |
| `GET /api/org/geo/districts` | apps/backend/src/org/geography.controller.ts:26 | **none** | no | yes | no |
| `GET /api/org/plants` | apps/backend/src/org/plants.controller.ts:16 | 'OPERATIONS_HEAD' | yes | no | no |
| `POST /api/org/plants` | apps/backend/src/org/plants.controller.ts:21 | (cls) 'OPERATIONS_HEAD' | yes | no | no |
| `GET /api/org/scoring-weights/components` | apps/backend/src/org/scoring-weights.controller.ts:29 | (cls) 'OPERATIONS_HEAD' | yes | no | no |
| `GET /api/org/scoring-weights` | apps/backend/src/org/scoring-weights.controller.ts:34 | (cls) 'OPERATIONS_HEAD' | yes | no | no |
| `POST /api/org/scoring-weights` | apps/backend/src/org/scoring-weights.controller.ts:39 | (cls) 'OPERATIONS_HEAD' | yes | no | no |
| `GET /api/org/engineers` | apps/backend/src/org/se-coverage.controller.ts:31 | 'OPERATIONS_HEAD' | yes | no | no |
| `POST /api/org/engineers` | apps/backend/src/org/se-coverage.controller.ts:36 | (cls) 'OPERATIONS_HEAD' | yes | no | no |
| `GET /api/org/engineers` | apps/backend/src/org/se-coverage.controller.ts:52 | 'OPERATIONS_HEAD' | yes | no | no |
| `POST /api/org/engineers` | apps/backend/src/org/se-coverage.controller.ts:57 | (cls) 'OPERATIONS_HEAD' | yes | no | no |
| `DELETE /api/org/engineers/:id` | apps/backend/src/org/se-coverage.controller.ts:65 | (cls) 'OPERATIONS_HEAD' | yes | no | no |
| `GET /api/org/se-territory` | apps/backend/src/org/se-territory.controller.ts:20 | 'OPERATIONS_HEAD' | yes | yes | no |
| `POST /api/org/se-territory` | apps/backend/src/org/se-territory.controller.ts:25 | (cls) 'OPERATIONS_HEAD' | yes | yes | no |
| `DELETE /api/org/se-territory/:id` | apps/backend/src/org/se-territory.controller.ts:33 | (cls) 'OPERATIONS_HEAD' | yes | yes | no |
| `GET /api/org/sla-rules` | apps/backend/src/org/sla-rules.controller.ts:20 | 'OPERATIONS_HEAD' | yes | no | no |
| `PUT /api/org/sla-rules` | apps/backend/src/org/sla-rules.controller.ts:25 | (cls) 'OPERATIONS_HEAD' | yes | no | no |
| `POST /api/org/tier-overrides` | apps/backend/src/org/tier-overrides.controller.ts:51 | 'OPERATIONS_HEAD','CENTRAL_SERVICE_MANAGER','ZONAL_MANAGER' | yes | no | no |
| `DELETE /api/org/tier-overrides/:id` | apps/backend/src/org/tier-overrides.controller.ts:68 | (cls) 'OPERATIONS_HEAD','CENTRAL_SERVICE_MANAGER','ZONAL_MANAGER' | yes | yes | no |
| `GET /api/org/tier-overrides` | apps/backend/src/org/tier-overrides.controller.ts:79 | (cls) 'OPERATIONS_HEAD','CENTRAL_SERVICE_MANAGER','ZONAL_MANAGER' | yes | no | no |
| `GET /api/org/tiers` | apps/backend/src/org/tiers.controller.ts:17 | 'OPERATIONS_HEAD' | yes | no | no |
| `GET /api/org/users` | apps/backend/src/org/users.controller.ts:16 | 'OPERATIONS_HEAD' | yes | no | no |
| `POST /api/org/users` | apps/backend/src/org/users.controller.ts:21 | (cls) 'OPERATIONS_HEAD' | yes | no | no |
| `PATCH /api/org/users/:userId` | apps/backend/src/org/users.controller.ts:29 | (cls) 'OPERATIONS_HEAD' | yes | yes | no |
| `GET /api/org/zone-mappings` | apps/backend/src/org/zone-mapping.controller.ts:55 | 'OPERATIONS_HEAD' | yes | yes | no |
| `GET /api/org/zone-mappings/pending` | apps/backend/src/org/zone-mapping.controller.ts:61 | (cls) 'OPERATIONS_HEAD' | yes | yes | no |
| `POST /api/org/zone-mappings/:id/map` | apps/backend/src/org/zone-mapping.controller.ts:66 | (cls) 'OPERATIONS_HEAD' | yes | yes | no |
| `POST /api/org/zone-mappings/:id/ignore` | apps/backend/src/org/zone-mapping.controller.ts:75 | (cls) 'OPERATIONS_HEAD' | yes | yes | no |
| `POST /api/org/zone-mappings/reapply` | apps/backend/src/org/zone-mapping.controller.ts:81 | (cls) 'OPERATIONS_HEAD' | yes | yes | no |
| `GET /api/org/plant-zone-overrides` | apps/backend/src/org/zone-mapping.controller.ts:87 | (cls) 'OPERATIONS_HEAD' | yes | yes | no |
| `PUT /api/org/plant-zone-overrides` | apps/backend/src/org/zone-mapping.controller.ts:93 | (cls) 'OPERATIONS_HEAD' | yes | yes | no |
| `GET /api/org/plant-zone-overrides/:sourcePlantId/impact` | apps/backend/src/org/zone-mapping.controller.ts:110 | (cls) 'OPERATIONS_HEAD' | yes | yes | no |
| `DELETE /api/org/plant-zone-overrides/:sourcePlantId` | apps/backend/src/org/zone-mapping.controller.ts:121 | (cls) 'OPERATIONS_HEAD' | yes | yes | no |
| `GET /api/org/zones` | apps/backend/src/org/zones.controller.ts:25 | 'CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | yes | no | no |
| `POST /api/org/zones` | apps/backend/src/org/zones.controller.ts:31 | 'CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | yes | no | no |
| `GET /api/settings/assignment-threshold` | apps/backend/src/settings/assignment-threshold.controller.ts:69 | 'OPERATIONS_HEAD','CENTRAL_SERVICE_MANAGER' | no | no | no |
| `PUT /api/settings/assignment-threshold` | apps/backend/src/settings/assignment-threshold.controller.ts:76 | 'OPERATIONS_HEAD','CENTRAL_SERVICE_MANAGER','ZONAL_MANAGER' | yes | no | no |
| `POST /api/settings/assignment-threshold/lock` | apps/backend/src/settings/assignment-threshold.controller.ts:84 | 'OPERATIONS_HEAD' | yes | no | no |
| `DELETE /api/settings/assignment-threshold/lock` | apps/backend/src/settings/assignment-threshold.controller.ts:90 | 'OPERATIONS_HEAD' | yes | no | no |
| `POST /api/settings/assignment-threshold/revert` | apps/backend/src/settings/assignment-threshold.controller.ts:97 | 'OPERATIONS_HEAD' | yes | no | no |
| `GET /api/settings` | apps/backend/src/settings/settings.controller.ts:24 | 'OPERATIONS_HEAD' | yes | no | no |
| `PUT /api/settings/:key` | apps/backend/src/settings/settings.controller.ts:29 | (cls) 'OPERATIONS_HEAD' | yes | no | no |
| `GET /api/zones/:zoneId` | apps/backend/src/zones/zones.controller.ts:8 | **none** | ? | ? | ? |
| `GET /api/ops-explorer/meta` | apps/backend/src/ops-explorer/ops-explorer.controller.ts:68 | (cls) ...OPS_EXPLORER_ROLE_NAMES | ? | ? | ? |
| `GET /api/ops-explorer/datasets/:key` | apps/backend/src/ops-explorer/ops-explorer.controller.ts:93 | (cls) ...OPS_EXPLORER_ROLE_NAMES | no | no | no |
| `POST /api/ops-explorer/datasets/:key/query` | apps/backend/src/ops-explorer/ops-explorer.controller.ts:99 | (cls) ...OPS_EXPLORER_ROLE_NAMES | no | no | no |
| `POST /api/ops-explorer/datasets/:key/export` | apps/backend/src/ops-explorer/ops-explorer.controller.ts:116 | (cls) ...OPS_EXPLORER_ROLE_NAMES | no | no | no |
| `GET /api/ops-explorer/reconciliation` | apps/backend/src/ops-explorer/ops-explorer.controller.ts:158 | (cls) ...OPS_EXPLORER_ROLE_NAMES | no | no | no |
| `GET /api/plants/deactivations` | apps/backend/src/plant-deactivation/plant-deactivation.controller.ts:16 | 'OPERATIONS_HEAD' | yes | no | no |
| `POST /api/plants/:plantId/deactivate` | apps/backend/src/plant-deactivation/plant-deactivation.controller.ts:22 | 'OPERATIONS_HEAD' | yes | no | no |
| `POST /api/plants/:plantId/reactivate` | apps/backend/src/plant-deactivation/plant-deactivation.controller.ts:40 | 'OPERATIONS_HEAD' | yes | yes | no |

**totals:** 57 endpoints · 4 with no @Roles at handler or class · 0 @Public · 2 write-verb endpoints with no audit write in the reached method

## prisma models plausibly owned (name match on module keywords)
- `SlaRuleConfig :443`
- `PriorityRuleConfig :459`

## spine edges owned by this module
| id | from | to | carrier | receiver | reverse | ev |
|---|---|---|---|---|---|---|
| E-26 | admin-config · Plant · DEACTIVATED | scheduling (SE day plan) | status flip — `cancelOpenTickets` + `batchAssignmentTicket.updateMany` strips stops; **no outbox row queued** | OH click deactivate | plantId, reason, cancelled ticket ids | *(blank — SE's phone is never told; `a human remembers` to call)* | `reactivate` :40 does not restore the plan | E2 `plant-deactivation/plant-deactivation.service.ts:165,229` · `plant-deactivation.controller.ts:22,40` | scheduling | BROKEN — S4 |

## env flags referenced in this module
- `USER`
- `USERNAME`
