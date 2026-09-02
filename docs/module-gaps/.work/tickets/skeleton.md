# skeleton — Tickets & Field Work Lifecycle (tickets)
generated 2026-09-02 · 0 TEQ · source: gapscope.profile.json

## admin routes (declared)
- `/tickets` — AppRoutes.tsx:79 → <TicketsPage>
- `/tickets/:ticketId` — **NOT FOUND in AppRoutes.tsx**
- `/install` — AppRoutes.tsx:356
- `/readiness/vehicle-unavailability` — AppRoutes.tsx:385
- `/readiness/non-operational` — AppRoutes.tsx:395
- `/readiness/recovery-decisions` — AppRoutes.tsx:404

## backend endpoints
### apps/backend/src/ticketing/install.controller.ts  `@Controller('install')`
- `POST /api/install` → `createSingle()` :130
- `POST /api/install/upload` → `upload()` :147
- `POST /api/install/:ticketId/schedule` → `schedule()` :169
- `POST /api/install/:ticketId/on-site` → `onSite()` :190
- `POST /api/install/:ticketId/fitted` → `fitted()` :198
- `GET /api/install/:ticketId` → `getOne()` :216

### apps/backend/src/ticketing/me-vehicle-unavailability.controller.ts  `@Controller('me/vehicle-unavailability')`
- `GET /api/me/vehicle-unavailability` → `list()` :17

### apps/backend/src/ticketing/non-operational.controller.ts  `@Controller('non-op')`
- `POST /api/non-op` → `request()` :66
- `GET /api/non-op/queue` → `queue()` :84
- `POST /api/non-op/:id/confirm` → `confirm()` :91
- `POST /api/non-op/:id/override-confirm` → `override()` :102
- `GET /api/non-op/confirm` → `confirmByToken()` :131

### apps/backend/src/ticketing/recovery.controller.ts  `@Controller('recovery')`
- `POST /api/recovery/:id/schedule` → `schedule()` :42
- `POST /api/recovery/:id/on-site` → `onSite()` :50
- `POST /api/recovery/:id/collected` → `collected()` :57
- `POST /api/recovery/:id/unable-to-collect` → `unable()` :70
- `POST /api/recovery/:id/receipt` → `receipt()` :78
- `GET /api/recovery/awaiting-receipt` → `awaitingReceipt()` :85
- `GET /api/recovery/zm-queue` → `zmQueue()` :92
- `GET /api/recovery/stalled` → `stalled()` :99
- `GET /api/recovery/non-standard-closures` → `nonStandard()` :106
- `POST /api/recovery/:id/reschedule` → `reschedule()` :113
- `POST /api/recovery/:id/close-failed` → `closeFailed()` :121
- `POST /api/recovery/:id/escalate` → `escalate()` :128
- `POST /api/recovery/:id/manual-close` → `manualClose()` :135

### apps/backend/src/ticketing/tickets.controller.ts  `@Controller('tickets')`
- `GET /api/tickets` → `list()` :40
- `GET /api/tickets/special-count` → `specialCount()` :82
- `GET /api/tickets/:id` → `getOne()` :88
- `GET /api/tickets/:id/forms` → `forms()` :101
- `GET /api/tickets/:id/attempts` → `attempts()` :119
- `POST /api/tickets/:id/auto-recovery-close` → `autoRecoveryClose()` :133

### apps/backend/src/ticketing/troubleshoot.controller.ts  `@Controller('tickets')`
- `POST /api/tickets/:id/troubleshoot` → `submit()` :44

### apps/backend/src/ticketing/vehicle-unavailability.controller.ts  `@Controller('vehicle-unavailability')`
- `POST /api/vehicle-unavailability` → `file()` :75
- `GET /api/vehicle-unavailability` → `list()` :105
- `GET /api/vehicle-unavailability/:id/history` → `history()` :115
- `POST /api/vehicle-unavailability/:id/confirm-date` → `confirmDate()` :128
- `POST /api/vehicle-unavailability/:id/approve` → `approve()` :140
- `POST /api/vehicle-unavailability/:id/override` → `override()` :158
- `POST /api/vehicle-unavailability/:id/resume-sla` → `resume()` :178

### apps/backend/src/me-tickets/me-tickets.controller.ts  `@Controller('me')`
- `GET /api/me/tickets` → `list()` :34
- `GET /api/me/work-history` → `history()` :43
- `GET /api/me/tickets/:id` → `detail()` :54
- `GET /api/me/tickets/:id/forms` → `forms()` :67

### apps/backend/src/media/media.controller.ts  `@Controller('media')`
- `POST /api/media/upload` → `upload()` :49
- `GET /api/media/:id` → `read()` :85

## backend units (services / schedulers / jobs)
- `apps/backend/src/ticketing/auto-recovery.service.ts` — if():65 · if():66 · class AutoRecoveryService:129 · runAutoRecovery():134 · manualClose():226 · closeAsAutoRecovery():283
- `apps/backend/src/ticketing/autorecovery-plan-export.ts` — for():29 · for():84
- `apps/backend/src/ticketing/customer-confirmation-notifier.ts` — sendConfirmationLink():20 · class LoggingCustomerConfirmationNotifier:26 · sendConfirmationLink():28
- `apps/backend/src/ticketing/install-lifecycle.service.ts` — class InstallLifecycleService:85 · scheduleInstall():97 · markOnSite():109 · markFitted():123 · runInstallVerification():171 · getInstallView():267
- `apps/backend/src/ticketing/install-notifier.ts` — installVerified():26 · failedActivation():27 · class LoggingInstallNotifier:33 · installVerified():35 · failedActivation():38 · class SpineInstallNotifier:47 · installVerified():50 · failedActivation():62
- `apps/backend/src/ticketing/install.service.ts` — class InstallService:101 · createSingle():105 · uploadCsv():132 · for():324 · if():330 · if():334 · for():341 · if():394 · if():399
- `apps/backend/src/ticketing/non-operational.service.ts` — class NonOperationalService:139 · requestMarking():157 · queue():217 · confirmByManager():231 · confirmByCustomer():254 · confirmByCustomerToken():276 · overrideConfirm():299
- `apps/backend/src/ticketing/recovery-criteria.ts` — if():42 · if():70
- `apps/backend/src/ticketing/recovery-notifier.ts` — recoveryClosed():33 · unableToCollect():34 · class LoggingRecoveryNotifier:42 · recoveryClosed():44 · unableToCollect():47 · escalatedToOh():50 · class SpineRecoveryNotifier:66 · recoveryClosed():74 · unableToCollect():86 · escalatedToOh():105
- `apps/backend/src/ticketing/recovery.service.ts` — class RecoveryService:83 · scheduleRecovery():95 · markOnSite():104 · markCollected():116 · confirmWarehouseReceipt():138 · markUnableToCollect():175 · rescheduleRecovery():212 · closeFailedRecovery():228 · escalateToOh():238 · manualClose():253 · awaitingReceipt():263 · stalledRecoveries():272 · nonStandardClosures():282 · zmDecisionQueue():291 · +2
- `apps/backend/src/ticketing/repeat-escalation.service.ts` — class RepeatEscalationService:23 · runEscalationScan():26
- `apps/backend/src/ticketing/sla-pause.ts` — if():56 · if():57
- `apps/backend/src/ticketing/special-ticket.query.ts` — class SpecialTicketQueryService:153 · verdictsFor():164 · attemptsFor():198
- `apps/backend/src/ticketing/ticket-creation.service.ts` — class TicketCreationService:40 · createForInactiveEligible():43
- `apps/backend/src/ticketing/ticket-query.service.ts` — class TicketQueryService:282 · list():301 · countSpecial():370 · getById():385 · formsForTicket():421
- `apps/backend/src/ticketing/troubleshoot-submission.service.ts` — class TroubleshootSubmissionService:102 · submit():108
- `apps/backend/src/ticketing/vehicle-return-resume-scheduler.service.ts` — class VehicleReturnResumeScheduler:57 · **CRON** :70 · resumeTick():71
- `apps/backend/src/ticketing/vehicle-return-resume.service.ts` — class VehicleReturnResumeService:56 · sweepReturnedVehicles():59
- `apps/backend/src/ticketing/vehicle-unavailability.service.ts` — class VehicleUnavailabilityService:134 · fileReport():140 · listForZone():239 · historyForTicket():250 · historyForReport():259 · bySe():275 · approve():332 · override():341 · resumeSla():434
- `apps/backend/src/me-tickets/me-ticket-detail.service.ts` — class MeTicketDetailService:39 · getTicketDetail():45
- `apps/backend/src/me-tickets/me-ticket-forms.service.ts` — class MeTicketFormsService:23 · getMyForms():29
- `apps/backend/src/me-tickets/me-tickets-query.service.ts` — if():14 · if():15 · class MeTicketsQueryService:32 · getMyTickets():38
- `apps/backend/src/me-tickets/me-work-history.service.ts` — class MeWorkHistoryService:103 · getWorkHistory():106 · if():194
- `apps/backend/src/me-tickets/se-ticket-access.ts` — if():32 · if():33 · if():36 · if():47
- `apps/backend/src/me-tickets/technical-hints.ts` — if():90 · if():91 · if():92 · if():93 · if():94 · if():95 · if():96 · if():97 · if():105 · if():133 · if():147
- `apps/backend/src/media/media.service.ts` — class MediaService:25 · create():28 · find():43
- `apps/backend/src/media/multer-error.filter.ts` — status():5 · class MulterErrorFilter:16 · catch():17

## admin UI files
- `apps/admin/src/pages/tickets/ticketBadges.tsx` — 115 loc · **no data hook**
- `apps/admin/src/pages/tickets/TicketDetailDrawer.tsx` — 536 loc · **no data hook**
- `apps/admin/src/pages/tickets/TicketsPage.tsx` — 360 loc · **no data hook**
- `apps/admin/src/pages/install/InstallCreatePage.tsx` — 300 loc · **no data hook**
- `apps/admin/src/pages/readiness/NonOperationalQueuePage.tsx` — 282 loc · **no data hook**
- `apps/admin/src/pages/readiness/RecoveryDecisionQueuePage.tsx` — 118 loc · **no data hook**
- `apps/admin/src/pages/readiness/VehicleUnavailabilityPage.tsx` — 363 loc · **no data hook**

## admin api client calls (apps/admin/src/api)

## mobile screens
- `apps/mobile/src/tickets/dayPlanCues.ts` — 48 loc
- `apps/mobile/src/tickets/detail/captureLocation.ts` — 20 loc
- `apps/mobile/src/tickets/detail/ticketDetailDisplay.ts` — 18 loc
- `apps/mobile/src/tickets/detail/TicketDetailScreen.tsx` — 651 loc
- `apps/mobile/src/tickets/install/installDisplay.ts` — 8 loc
- `apps/mobile/src/tickets/install/InstallFormScreen.tsx` — 211 loc
- `apps/mobile/src/tickets/recovery/CollectionFormScreen.tsx` — 168 loc
- `apps/mobile/src/tickets/recovery/recoveryDisplay.ts` — 18 loc
- `apps/mobile/src/tickets/recovery/UnableToCollectScreen.tsx` — 163 loc
- `apps/mobile/src/tickets/ticketDisplay.ts` — 50 loc
- `apps/mobile/src/tickets/troubleshoot/ConflictScreen.tsx` — 99 loc
- `apps/mobile/src/tickets/troubleshoot/troubleshootDisplay.ts` — 30 loc
- `apps/mobile/src/tickets/troubleshoot/TroubleshootFormScreen.tsx` — 192 loc
- `apps/mobile/src/tickets/vehicle-unavailability/vehicleUnavailabilityDisplay.ts` — 66 loc
- `apps/mobile/src/tickets/vehicle-unavailability/VehicleUnavailabilityFormScreen.tsx` — 299 loc
- `apps/mobile/src/tickets/verification/VerificationScreen.tsx` — 216 loc
- `apps/mobile/src/device/deviceId.ts` — 20 loc

## tests touching this module
- `apps/backend/test/integration-sync-tickets.e2e-spec.ts`
- `apps/backend/test/me-tickets-controller.e2e-spec.ts`
- `apps/backend/test/me-tickets-removal-metadata.e2e-spec.ts`
- `apps/backend/test/tickets-api.e2e-spec.ts`
- `apps/backend/test/tickets-list-detail.e2e-spec.ts`
- `apps/mobile/src/navigation/screens/TicketsScreen.test.tsx`
