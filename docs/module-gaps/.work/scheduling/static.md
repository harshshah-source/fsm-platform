> **CAVEAT (measured 2026-09-02):** the `audit` column follows only ONE delegation hop — it reports "no" whenever the audit write sits in a shared private helper. Verified false-positive rates: scheduling 11/11, tickets 8/10, cross-zone 6/6, vouchers 0/0, ingestion 0/3. Error is one-directional (under-detects, never invents), so "yes" is trustworthy and every "no" must be checked at `file:line`. The `guard` column can be off by one decorator. Never infer a UI facade from skeleton.md "no data hook" — admin pages use `useEffect` + `apps/admin/src/api/`, not react-query.

# static facts — Batch Scheduling & Dispatch (scheduling)
columns: guard = @Roles/@Public on the handler · audit = withAudit/record/auditLog.create in the reached service · status = writes a *status/state* field · tx = $transaction

| endpoint | file:line | guard | audit | status-write | tx |
|---|---|---|---|---|---|
| `GET /api/batches/:batchId` | apps/backend/src/scheduling/batches.controller.ts:59 | ...MANAGER_ROLES | no | yes | no |
| `POST /api/batches/:id/override/preview` | apps/backend/src/scheduling/batches.controller.ts:85 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | no | no |
| `POST /api/batches/:id/override` | apps/backend/src/scheduling/batches.controller.ts:108 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | yes | no | no |
| `GET /api/dispatch-runs` | apps/backend/src/scheduling/dispatch-runs.controller.ts:46 | ...MANAGER_ROLES | no | yes | no |
| `GET /api/dispatch-runs/:runId` | apps/backend/src/scheduling/dispatch-runs.controller.ts:54 | ...MANAGER_ROLES | no | yes | no |
| `GET /api/dispatch-runs/:runId/zones/:zoneId` | apps/backend/src/scheduling/dispatch-runs.controller.ts:62 | ...MANAGER_ROLES | no | yes | no |
| `GET /api/dispatch-runs/:runId/decisions` | apps/backend/src/scheduling/dispatch-runs.controller.ts:81 | ...MANAGER_ROLES | no | yes | no |
| `GET /api/dispatch-runs/:runId/tickets/:ticketId/trace` | apps/backend/src/scheduling/dispatch-runs.controller.ts:99 | ...MANAGER_ROLES | no | yes | no |
| `GET /api/dispatch/today` | apps/backend/src/scheduling/dispatch-today.controller.ts:39 | ...MANAGER_ROLES | no | yes | no |
| `GET /api/dispatch/changes-today` | apps/backend/src/scheduling/dispatch-today.controller.ts:45 | ...MANAGER_ROLES | no | no | no |
| `POST /api/dispatch/card-summaries` | apps/backend/src/scheduling/dispatch-today.controller.ts:65 | ...MANAGER_ROLES | no | yes | no |
| `GET /api/intraday-updates` | apps/backend/src/scheduling/intraday-updates.controller.ts:34 | ...MANAGER_ROLES | no | no | no |
| `POST /api/intraday-updates/add` | apps/backend/src/scheduling/intraday-updates.controller.ts:40 | ...MANAGER_ROLES | no | no | no |
| `POST /api/intraday-updates/remove` | apps/backend/src/scheduling/intraday-updates.controller.ts:75 | ...MANAGER_ROLES | no | no | no |
| `POST /api/intraday-updates/reorder` | apps/backend/src/scheduling/intraday-updates.controller.ts:99 | ...MANAGER_ROLES | no | no | no |
| `GET /api/schedules/dispatch-schedule` | apps/backend/src/scheduling/schedules.controller.ts:176 | 'OPERATIONS_HEAD','CENTRAL_SERVICE_MANAGER','ZONAL_MANAGER' | yes | no | no |
| `PUT /api/schedules/dispatch-schedule` | apps/backend/src/scheduling/schedules.controller.ts:182 | 'OPERATIONS_HEAD','CENTRAL_SERVICE_MANAGER','ZONAL_MANAGER' | yes | no | no |
| `POST /api/schedules/dispatch-run` | apps/backend/src/scheduling/schedules.controller.ts:225 | 'OPERATIONS_HEAD','CENTRAL_SERVICE_MANAGER','ZONAL_MANAGER' | no | no | no |
| `GET /api/schedules/dispatch-run/in-flight` | apps/backend/src/scheduling/schedules.controller.ts:277 | 'OPERATIONS_HEAD','CENTRAL_SERVICE_MANAGER','ZONAL_MANAGER' | yes | no | no |
| `POST /api/schedules/bulk-unassign` | apps/backend/src/scheduling/schedules.controller.ts:290 | 'OPERATIONS_HEAD' | no | no | no |
| `GET /api/schedules/bulk-unassign/history` | apps/backend/src/scheduling/schedules.controller.ts:317 | 'OPERATIONS_HEAD' | no | no | no |
| `GET /api/schedules/preview` | apps/backend/src/scheduling/schedules.controller.ts:333 | ...MANAGER_ROLES | no | no | no |
| `POST /api/schedules/holds` | apps/backend/src/scheduling/schedules.controller.ts:356 | ...MANAGER_ROLES | yes | yes | no |
| `POST /api/schedules/holds/release` | apps/backend/src/scheduling/schedules.controller.ts:400 | ...MANAGER_ROLES | yes | yes | no |
| `GET /api/schedules/me` | apps/backend/src/scheduling/schedules.controller.ts:418 | 'SERVICE_ENGINEER' | no | yes | no |
| `POST /api/schedules/assign` | apps/backend/src/scheduling/schedules.controller.ts:424 | 'SERVICE_ENGINEER' | no | no | no |
| `POST /api/schedules/assign-plants` | apps/backend/src/scheduling/schedules.controller.ts:465 | ...MANAGER_ROLES | no | no | no |
| `POST /api/schedules/assign-batch` | apps/backend/src/scheduling/schedules.controller.ts:491 | ...MANAGER_ROLES | no | no | yes |
| `GET /api/schedules` | apps/backend/src/scheduling/schedules.controller.ts:523 | ...MANAGER_ROLES | no | yes | no |
| `GET /api/schedules/engineers` | apps/backend/src/scheduling/schedules.controller.ts:557 | ...MANAGER_ROLES | no | yes | no |
| `GET /api/schedules/assignable-work` | apps/backend/src/scheduling/schedules.controller.ts:579 | ...MANAGER_ROLES | no | yes | no |
| `GET /api/schedules/candidates` | apps/backend/src/scheduling/schedules.controller.ts:595 | ...MANAGER_ROLES | no | no | no |
| `GET /api/schedules/assignable-tickets` | apps/backend/src/scheduling/schedules.controller.ts:612 | ...MANAGER_ROLES | no | no | no |
| `POST /api/schedules/distribute-preview` | apps/backend/src/scheduling/schedules.controller.ts:629 | ...MANAGER_ROLES | no | no | no |
| `GET /api/schedules/:engineerId` | apps/backend/src/scheduling/schedules.controller.ts:647 | ...MANAGER_ROLES | no | yes | no |
| `GET /api/me/shared-pool` | apps/backend/src/shared-pool/shared-pool.controller.ts:19 | 'SERVICE_ENGINEER' | no | yes | no |

**totals:** 36 endpoints · 0 with no @Roles at handler or class · 0 @Public · 11 write-verb endpoints with no audit write in the reached method

## prisma models plausibly owned (name match on module keywords)
_no model name matched the slug — surveyor must map by hand_

## spine edges owned by this module
| id | from | to | carrier | receiver | reverse | ev |
|---|---|---|---|---|---|---|
| E-02 | tickets · Ticket · OPEN unassigned | scheduling | in-process `RecommenderService.runForZone` inside `dispatchForZone` | cron `dispatchTick` | ticketId, plantId, tier, SLA due | `/dispatch/today` TodaysDispatchPage.tsx · ZM | unassignable list ZoneUnassignableTable.tsx | E2 `recommender/recommender.service.ts:275` · `scheduling/batch-assignment.service.ts:136` · `scheduling/dispatch-scheduler.service.ts:85` | scheduling | OK |
| E-03 | scheduling · Candidate · scored | scheduling | status flip → `BatchAssignment` + `BatchAssignmentTicket` rows | cron `dispatchTick` | seId, scheduleId, batchId, stop order | `/batches/:batchId` DispatchBatchDetailPage.tsx · ZM | `POST /api/batches/:id/override` :108 | E2 `scheduling/batches.controller.ts:108` · `scheduling/override.service.ts:265` | scheduling | OK |
| E-04 | scheduling · Batch · DISPATCHED | notifications | outbox row `queueDayPlanDispatched` written in the same tx | commit of the per-SE dispatch tx | seId, scheduleId, zoneId, stops, tickets | drained by cron `notificationOutboxTick` | `queueDayPlanOverridden` :44 on override | E2 `scheduling/day-plan-notification-outbox.ts:22,44` · `scheduling/business-sweep-scheduler.service.ts:280` | notifications | OK |
| E-05 | notifications · DayPlan event · queued | scheduling (SE phone) | **push seam returns UNAVAILABLE** — in-app row only, SE must open app | cron drain | title, body, scheduleId | *(blank for push)* — in-app only at NotificationsScreen.tsx via HomeScreen.tsx:147 · SE | none | E2 `notifications/notification-channel.gateway.ts:37` (`return 'UNAVAILABLE'`) | notifications | BROKEN — S4 |
| E-06 | scheduling · DayPlan · live | tickets (mobile) | route `GET /api/schedules/me` | SE opens app | stops, plant, ticket ids, ETA | HomeScreen.tsx · SE | none | E2 `scheduling/schedules.controller.ts:418` | scheduling | OK |
| E-09 | tickets · Submission · saved | verification | cron sweep `runVerification` | cron `verificationTick` | ticketId, submissionId, GPS pair, device telemetry | `/verification` VerificationReviewPage.tsx · ZM | none | E2 `verification/verification.service.ts:48` · `scheduling/business-sweep-scheduler.service.ts:219` | verification | OK |
| E-18 | tickets · CRITICAL Ticket · arrives mid-day | intraday | cron sweep `assignCriticalForZone` | cron `criticalAssignTick` | ticketId, zoneId, tier, candidate SEs | `/intraday` IntradayQueuePage.tsx · ZM | `manual-assign` :79 | E2 `intraday/intraday-insertion.service.ts:172` · `scheduling/business-sweep-scheduler.service.ts:229` | intraday | OK |
| E-23 | scheduling · Ticket · unassignable in home zone | cross-zone | cron sweep `sweepAutoEscalations` | cron `crossZoneTick` | ticketId, homeZoneId, tier, age | `/cross-zone` CrossZonePage.tsx · CSM/OH | `deny` :81 → `re-escalate` :101 · `defer` :89 | E2 `cross-zone/cross-zone-escalation.service.ts:74` · `scheduling/business-sweep-scheduler.service.ts:236` | cross-zone | OK |
| E-24 | cross-zone · Escalation · APPROVED | scheduling | in-process `override.assignTicket(..., 'CROSS_ZONE_ASSIGN')` + `notifyHomeZm` | CSM/OH click | ticketId, targetZoneId, seId, scheduleId, batchId | home ZM notified; **target-zone SE relies on E-05's broken push** | `deny`/`defer` leave the ticket in home queue | E2 `cross-zone/cross-zone-escalation.service.ts:150-180` | scheduling | PARTIAL — S3 |
| E-26 | admin-config · Plant · DEACTIVATED | scheduling (SE day plan) | status flip — `cancelOpenTickets` + `batchAssignmentTicket.updateMany` strips stops; **no outbox row queued** | OH click deactivate | plantId, reason, cancelled ticket ids | *(blank — SE's phone is never told; `a human remembers` to call)* | `reactivate` :40 does not restore the plan | E2 `plant-deactivation/plant-deactivation.service.ts:165,229` · `plant-deactivation.controller.ts:22,40` | scheduling | BROKEN — S4 |
| E-28 | tickets + verification + vouchers · closures | reports | nightly cron recomputes (efficiency, root-cause, ZM scorecard, fleet uptime) | cron `systemEfficiencyTick` etc. | closure counts, verdicts, SLA breaches, per-SE totals | `/reports/*` · OH/ZM | manual `POST /reports/*/recompute` | E2 `scheduling/business-sweep-scheduler.service.ts:255,260,265,270` · `reports/reports.controller.ts:125,176,194,261` | reports | OK |

## env flags referenced in this module
- `BUSINESS_SWEEPS_ENABLED`
- `JWT_ACCESS_SECRET`
