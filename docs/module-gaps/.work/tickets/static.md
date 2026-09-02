> **CAVEAT (measured 2026-09-02):** the `audit` column follows only ONE delegation hop — it reports "no" whenever the audit write sits in a shared private helper. Verified false-positive rates: scheduling 11/11, tickets 8/10, cross-zone 6/6, vouchers 0/0, ingestion 0/3. Error is one-directional (under-detects, never invents), so "yes" is trustworthy and every "no" must be checked at `file:line`. The `guard` column can be off by one decorator. Never infer a UI facade from skeleton.md "no data hook" — admin pages use `useEffect` + `apps/admin/src/api/`, not react-query.

# static facts — Tickets & Field Work Lifecycle (tickets)
columns: guard = @Roles/@Public on the handler · audit = withAudit/record/auditLog.create in the reached service · status = writes a *status/state* field · tx = $transaction

| endpoint | file:line | guard | audit | status-write | tx |
|---|---|---|---|---|---|
| `POST /api/install` | apps/backend/src/ticketing/install.controller.ts:130 | ...CREATOR_ROLES | no | no | yes |
| `POST /api/install/upload` | apps/backend/src/ticketing/install.controller.ts:147 | ...CREATOR_ROLES | no | no | yes |
| `POST /api/install/:ticketId/schedule` | apps/backend/src/ticketing/install.controller.ts:169 | ...SCHEDULER_ROLES | yes | yes | no |
| `POST /api/install/:ticketId/on-site` | apps/backend/src/ticketing/install.controller.ts:190 | 'SERVICE_ENGINEER' | yes | yes | no |
| `POST /api/install/:ticketId/fitted` | apps/backend/src/ticketing/install.controller.ts:198 | 'SERVICE_ENGINEER' | yes | yes | no |
| `GET /api/install/:ticketId` | apps/backend/src/ticketing/install.controller.ts:216 | ...INSTALL_READER_ROLES | yes | yes | no |
| `GET /api/me/vehicle-unavailability` | apps/backend/src/ticketing/me-vehicle-unavailability.controller.ts:17 | 'SERVICE_ENGINEER' | no | yes | no |
| `POST /api/non-op` | apps/backend/src/ticketing/non-operational.controller.ts:66 | ...MANAGER_ROLES | yes | yes | no |
| `GET /api/non-op/queue` | apps/backend/src/ticketing/non-operational.controller.ts:84 | ...MANAGER_ROLES | yes | yes | no |
| `POST /api/non-op/:id/confirm` | apps/backend/src/ticketing/non-operational.controller.ts:91 | ...MANAGER_ROLES | yes | no | no |
| `POST /api/non-op/:id/override-confirm` | apps/backend/src/ticketing/non-operational.controller.ts:102 | 'OPERATIONS_HEAD' | yes | yes | no |
| `GET /api/non-op/confirm` | apps/backend/src/ticketing/non-operational.controller.ts:131 | **PUBLIC** | yes | yes | no |
| `POST /api/recovery/:id/schedule` | apps/backend/src/ticketing/recovery.controller.ts:42 | ...MANAGER_ROLES | yes | yes | no |
| `POST /api/recovery/:id/on-site` | apps/backend/src/ticketing/recovery.controller.ts:50 | ...MANAGER_ROLES | yes | yes | no |
| `POST /api/recovery/:id/collected` | apps/backend/src/ticketing/recovery.controller.ts:57 | 'SERVICE_ENGINEER' | yes | yes | no |
| `POST /api/recovery/:id/unable-to-collect` | apps/backend/src/ticketing/recovery.controller.ts:70 | 'SERVICE_ENGINEER' | yes | yes | no |
| `POST /api/recovery/:id/receipt` | apps/backend/src/ticketing/recovery.controller.ts:78 | 'SERVICE_ENGINEER' | yes | yes | no |
| `GET /api/recovery/awaiting-receipt` | apps/backend/src/ticketing/recovery.controller.ts:85 | 'WAREHOUSE_MANAGER' | yes | yes | no |
| `GET /api/recovery/zm-queue` | apps/backend/src/ticketing/recovery.controller.ts:92 | 'WAREHOUSE_MANAGER',...MANAGER_ROLES | yes | yes | no |
| `GET /api/recovery/stalled` | apps/backend/src/ticketing/recovery.controller.ts:99 | ...MANAGER_ROLES | yes | yes | no |
| `GET /api/recovery/non-standard-closures` | apps/backend/src/ticketing/recovery.controller.ts:106 | ...MANAGER_ROLES | yes | yes | no |
| `POST /api/recovery/:id/reschedule` | apps/backend/src/ticketing/recovery.controller.ts:113 | ...MANAGER_ROLES | no | yes | no |
| `POST /api/recovery/:id/close-failed` | apps/backend/src/ticketing/recovery.controller.ts:121 | ...MANAGER_ROLES | no | yes | no |
| `POST /api/recovery/:id/escalate` | apps/backend/src/ticketing/recovery.controller.ts:128 | ...MANAGER_ROLES | no | yes | no |
| `POST /api/recovery/:id/manual-close` | apps/backend/src/ticketing/recovery.controller.ts:135 | ...MANAGER_ROLES | no | yes | yes |
| `GET /api/tickets` | apps/backend/src/ticketing/tickets.controller.ts:40 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | yes | no |
| `GET /api/tickets/special-count` | apps/backend/src/ticketing/tickets.controller.ts:82 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | no | no |
| `GET /api/tickets/:id` | apps/backend/src/ticketing/tickets.controller.ts:88 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | no | no |
| `GET /api/tickets/:id/forms` | apps/backend/src/ticketing/tickets.controller.ts:101 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | no | no |
| `GET /api/tickets/:id/attempts` | apps/backend/src/ticketing/tickets.controller.ts:119 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | no | no |
| `POST /api/tickets/:id/auto-recovery-close` | apps/backend/src/ticketing/tickets.controller.ts:133 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | yes | yes |
| `POST /api/tickets/:id/troubleshoot` | apps/backend/src/ticketing/troubleshoot.controller.ts:44 | 'SERVICE_ENGINEER' | yes | yes | yes |
| `POST /api/vehicle-unavailability` | apps/backend/src/ticketing/vehicle-unavailability.controller.ts:75 | 'SERVICE_ENGINEER',...MANAGER_ROLES | no | yes | yes |
| `GET /api/vehicle-unavailability` | apps/backend/src/ticketing/vehicle-unavailability.controller.ts:105 | ...MANAGER_ROLES | no | yes | no |
| `GET /api/vehicle-unavailability/:id/history` | apps/backend/src/ticketing/vehicle-unavailability.controller.ts:115 | ...MANAGER_ROLES | no | yes | no |
| `POST /api/vehicle-unavailability/:id/confirm-date` | apps/backend/src/ticketing/vehicle-unavailability.controller.ts:128 | ...MANAGER_ROLES | yes | yes | no |
| `POST /api/vehicle-unavailability/:id/approve` | apps/backend/src/ticketing/vehicle-unavailability.controller.ts:140 | ...MANAGER_ROLES | yes | yes | no |
| `POST /api/vehicle-unavailability/:id/override` | apps/backend/src/ticketing/vehicle-unavailability.controller.ts:158 | ...MANAGER_ROLES | yes | yes | no |
| `POST /api/vehicle-unavailability/:id/resume-sla` | apps/backend/src/ticketing/vehicle-unavailability.controller.ts:178 | ...MANAGER_ROLES | no | yes | yes |
| `GET /api/me/tickets` | apps/backend/src/me-tickets/me-tickets.controller.ts:34 | 'SERVICE_ENGINEER' | no | yes | no |
| `GET /api/me/work-history` | apps/backend/src/me-tickets/me-tickets.controller.ts:43 | 'SERVICE_ENGINEER' | no | no | no |
| `GET /api/me/tickets/:id` | apps/backend/src/me-tickets/me-tickets.controller.ts:54 | 'SERVICE_ENGINEER' | no | yes | no |
| `GET /api/me/tickets/:id/forms` | apps/backend/src/me-tickets/me-tickets.controller.ts:67 | 'SERVICE_ENGINEER' | no | yes | no |
| `POST /api/media/upload` | apps/backend/src/media/media.controller.ts:49 | 'SERVICE_ENGINEER' | no | no | no |
| `GET /api/media/:id` | apps/backend/src/media/media.controller.ts:85 | 'SERVICE_ENGINEER',...REVIEW_ROLES | no | no | no |

**totals:** 45 endpoints · 0 with no @Roles at handler or class · 1 @Public · 10 write-verb endpoints with no audit write in the reached method

## prisma models plausibly owned (name match on module keywords)
_no model name matched the slug — surveyor must map by hand_

## spine edges owned by this module
| id | from | to | carrier | receiver | reverse | ev |
|---|---|---|---|---|---|---|
| E-01 | ingestion · Device · INACTIVE+eligible | tickets | in-process call `createForInactiveEligible()` | cron `telemetryTick` | deviceId, plantId, cycleId, tier | `/tickets` TicketsPage.tsx:1 · ZM | none — device returning ACTIVE does not close the Ticket | E2 `ingestion/autoplant/integration-sync.service.ts:165` · `integration-scheduler.service.ts:77` | tickets | PARTIAL — no reverse ⇒ S3 |
| E-02 | tickets · Ticket · OPEN unassigned | scheduling | in-process `RecommenderService.runForZone` inside `dispatchForZone` | cron `dispatchTick` | ticketId, plantId, tier, SLA due | `/dispatch/today` TodaysDispatchPage.tsx · ZM | unassignable list ZoneUnassignableTable.tsx | E2 `recommender/recommender.service.ts:275` · `scheduling/batch-assignment.service.ts:136` · `scheduling/dispatch-scheduler.service.ts:85` | scheduling | OK |
| E-04 | scheduling · Batch · DISPATCHED | notifications | outbox row `queueDayPlanDispatched` written in the same tx | commit of the per-SE dispatch tx | seId, scheduleId, zoneId, stops, tickets | drained by cron `notificationOutboxTick` | `queueDayPlanOverridden` :44 on override | E2 `scheduling/day-plan-notification-outbox.ts:22,44` · `scheduling/business-sweep-scheduler.service.ts:280` | notifications | OK |
| E-06 | scheduling · DayPlan · live | tickets (mobile) | route `GET /api/schedules/me` | SE opens app | stops, plant, ticket ids, ETA | HomeScreen.tsx · SE | none | E2 `scheduling/schedules.controller.ts:418` | scheduling | OK |
| E-07 | tickets · Ticket · SE en-route | dashboard | route `POST /api/tickets/:id/soft-state` + `/api/me/activity-ping` | SE tap | ticketId, soft state, lat/lng | `/` zone-operations · ZM | soft state expires | E2 `soft-state/soft-state.controller.ts:34,60` | dashboard | OK |
| E-08 | tickets (mobile) · Troubleshoot form · submitted | tickets | route `POST /api/tickets/:id/troubleshoot` (tx + status flip + audit) | SE submit | verdict, components consumed, photos, GPS | TicketDetailDrawer.tsx · ZM | 409 → ConflictScreen.tsx (see E-14) | E2 `ticketing/troubleshoot.controller.ts:44` · `troubleshoot-submission.service.ts:108` | tickets | OK |
| E-09 | tickets · Submission · saved | verification | cron sweep `runVerification` | cron `verificationTick` | ticketId, submissionId, GPS pair, device telemetry | `/verification` VerificationReviewPage.tsx · ZM | none | E2 `verification/verification.service.ts:48` · `scheduling/business-sweep-scheduler.service.ts:219` | verification | OK |
| E-10 | verification · Run · FRAUD_SUSPECT | tickets | route `POST /api/verification/:ticketId/escalate` (tx+audit) | ZM click | ticketId, reason, actor | `/tickets` + `/reports/root-cause` · ZM/OH | `mark-auto-recovery` :88 is the other branch; no un-escalate | E2 `verification/verification.controller.ts:67,88` | tickets | PARTIAL — no reverse ⇒ S3 |
| E-11 | tickets · Consumed components · PRE_VERIFICATION | inventory | status flip — `InventoryTransaction` + `ComponentRequest` created in submit tx | SE submit | seId, componentId, qty, ticketId, submissionId | `/warehouse/requests` (WM) + `/component-requests` (ZM) | `POST /warehouse/requests/:id/reject` :80 | E2 `ticketing/troubleshoot-submission.service.ts:225,300-307` · `component-request/warehouse.controller.ts:52` | inventory | OK |
| E-12 | inventory · ComponentRequest · SHIPPED | tickets (mobile) | route `GET /api/me/component-requests` exists | WM click ship | requestId, componentId, qty, courier, ETA | **blank — no mobile screen consumes it** (mobile/stock has only vanStockDisplay.ts + StockScreen.tsx) | `confirm-receipt` :42 is ZM-only, not SE | E2 `component-request/me-component-requests.controller.ts:17` · `component-request/warehouse.controller.ts:64` · mobile `navigation/SeTabShell.tsx:66-70` | tickets | BROKEN — S4 |
| E-14 | tickets · Losing SE's stock · SHADOW_USE | inventory | status flip inside 409 handler; van stock decremented | business-409 on submit | seId, componentId, qty, ticketId, winnerSeId | `/warehouse/shadow-use` ShadowUseQueuePage.tsx · WM | `POST /shadow-use/:id/dispute` :53 flips status but **never restores the decremented van stock** | E2 `ticketing/troubleshoot-submission.service.ts:329-360` · `inventory/shadow-use.controller.ts:53` · `inventory/shadow-use.service.ts:72` | inventory | BROKEN — S4 + DANGEROUS (stock/financial) |
| E-15 | tickets · Ticket · CLOSED | vouchers | **a human remembers** — SE opens the Vouchers tab and re-keys the trip | SE decides | amount, category, photo, date | `/vouchers` VoucherReviewPage.tsx · ZM/CSM | resubmit :161 | E2 `vouchers/vouchers.controller.ts:62` · mobile `vouchers/VoucherFormScreen.tsx` (no ticket carrier from TicketDetailScreen) | vouchers | MANUAL — S3 (C2) |
| E-18 | tickets · CRITICAL Ticket · arrives mid-day | intraday | cron sweep `assignCriticalForZone` | cron `criticalAssignTick` | ticketId, zoneId, tier, candidate SEs | `/intraday` IntradayQueuePage.tsx · ZM | `manual-assign` :79 | E2 `intraday/intraday-insertion.service.ts:172` · `scheduling/business-sweep-scheduler.service.ts:229` | intraday | OK |
| E-20 | tickets (mobile) · SE cannot do a stop · declines | intraday | **a human remembers** — accept/decline endpoints were deleted with the offer machinery | *(none)* | ticketId, seId, decline reason | *(blank — no SE-side decline control, no ZM decline queue)* | none | E2 `intraday/intraday-insertion.controller.ts:36` ("`accept`, `decline` and `sweep-timeouts` are gone") | intraday | BROKEN — S4 (C1/C2) |
| E-21 | tickets (mobile) · Vehicle unavailable · filed | tickets | route `POST /api/vehicle-unavailability` (tx+status) → ZM approve :140 → SLA pause | SE submit then ZM approve | ticketId, vehicleNo, expected return date, evidence | `/readiness/vehicle-unavailability` VehicleUnavailabilityPage.tsx · ZM | `override` :158 · `resume-sla` :178 · cron `resumeTick` sweeps returned vehicles | E2 `ticketing/vehicle-unavailability.controller.ts:75,140,158,178` · `ticketing/vehicle-return-resume-scheduler.service.ts:71` | tickets | OK |
| E-22 | tickets · Non-operational marking · requested | tickets (customer) | **public token link** — but the notifier only logs, no SMS/WhatsApp adapter | ZM click | ticketId, plant, token, reason | *(blank externally)* · fallback `override-confirm` :102 · OH | `override-confirm` is the only escape | E2 `ticketing/non-operational.controller.ts:66,102,131` · `ticketing/customer-confirmation-notifier.ts:26` (LoggingCustomerConfirmationNotifier) | tickets | PARTIAL — S3 |
| E-25 | ingestion · Device · departed from master sync | tickets | in-process `DeviceDepartureService.reconcile` during master sync | cron `mastersTick` | deviceId, plantId, last seen, open ticket ids | *(blank — output is `stand-down-export.ts`, a file; no admin screen, `/build-health` shows only health)* | none | E2 `device-departure/device-departure.service.ts:137` · `ingestion/autoplant/master-sync.service.ts:7` · `device-departure/stand-down-export.ts:34` | tickets | BROKEN — S4 |
| E-27 | tickets · Recovery · COLLECTED by SE | inventory | status flip → `GET /api/recovery/awaiting-receipt` worklist | SE `POST /recovery/:id/collected` :57 | ticketId, deviceId, seId, collected at | `/warehouse/recovery-receipt` RecoveryReceiptQueuePage.tsx · WM | `unable-to-collect` :70 → `reschedule` :113 / `close-failed` :121 / `escalate` :128 | E2 `ticketing/recovery.controller.ts:57,70,78,85` | inventory | OK |
| E-28 | tickets + verification + vouchers · closures | reports | nightly cron recomputes (efficiency, root-cause, ZM scorecard, fleet uptime) | cron `systemEfficiencyTick` etc. | closure counts, verdicts, SLA breaches, per-SE totals | `/reports/*` · OH/ZM | manual `POST /reports/*/recompute` | E2 `scheduling/business-sweep-scheduler.service.ts:255,260,265,270` · `reports/reports.controller.ts:125,176,194,261` | reports | OK |

## env flags referenced in this module
- `INSTALL_CSV_MAX_ROWS`
- `PUBLIC_API_URL`
