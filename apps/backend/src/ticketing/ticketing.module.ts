import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SharedPoolModule } from '../shared-pool/shared-pool.module';
import { AutoRecoveryService } from './auto-recovery.service';
import {
  CUSTOMER_CONFIRMATION_NOTIFIER,
  LoggingCustomerConfirmationNotifier,
} from './customer-confirmation-notifier';
import { InstallService } from './install.service';
import { InstallLifecycleService } from './install-lifecycle.service';
import { INSTALL_NOTIFIER, SpineInstallNotifier } from './install-notifier';
import { NonOperationalService } from './non-operational.service';
import { RECOVERY_NOTIFIER, SpineRecoveryNotifier } from './recovery-notifier';
import { RecoveryService } from './recovery.service';
import { RepeatEscalationService } from './repeat-escalation.service';
import { TicketCreationService } from './ticket-creation.service';
import { TicketQueryService } from './ticket-query.service';
import { SpecialTicketQueryService } from './special-ticket.query';
import { TroubleshootSubmissionService } from './troubleshoot-submission.service';
import { CronTickClaimModule } from '../scheduling/cron-tick-claim.module';
import { CronTickClaimService } from '../scheduling/cron-tick-claim.service';
import { VehicleReturnResumeService } from './vehicle-return-resume.service';
import { VehicleReturnResumeScheduler } from './vehicle-return-resume-scheduler.service';
import { VehicleUnavailabilityService } from './vehicle-unavailability.service';

/**
 * Ticketing (Issue 05). The TROUBLESHOOT spine: `TicketCreationService` turns newly-inactive
 * eligible `device_states` into Failure Cycles + Tickets, and `TicketQueryService` backs the
 * `/api/tickets/*` read surface (`TicketsController` is registered in AppModule alongside the shared
 * guards, mirroring `SnapshotsController`). Install/Recovery work types and the SE-facing Day Plan /
 * Shared Pool surfaces are layered on by later issues.
 */
@Module({
  // CronTickClaimModule (#263) supplies the tick arbiter to the vu-auto-resume scheduler below. It
  // imports nothing itself, so it cannot introduce a cycle here.
  imports: [PrismaModule, AuditModule, SharedPoolModule, NotificationsModule, CronTickClaimModule],
  providers: [
    TicketCreationService,
    TicketQueryService,
    SpecialTicketQueryService,
    AutoRecoveryService,
    RepeatEscalationService,
    TroubleshootSubmissionService,
    VehicleUnavailabilityService,
    // #247 — the date-driven half of SLA-resume correctness. The sweep is plain DI (Prisma only); the
    // scheduler is factory-provided, mirroring the ingestion / business-sweep / closure schedulers, so
    // its optional `config` param reads the environment rather than being DI-resolved.
    VehicleReturnResumeService,
    {
      provide: VehicleReturnResumeScheduler,
      useFactory: (resume: VehicleReturnResumeService, claims: CronTickClaimService) =>
        new VehicleReturnResumeScheduler(resume, claims),
      inject: [VehicleReturnResumeService, CronTickClaimService],
    },
    NonOperationalService,
    // #76 — the customer confirmation link has no internal recipient User row (external party, no
    // account), so it structurally can't route through NotificationService.notify's
    // {userId, role} recipient model; stays on the Logging stub, not "adopted" here.
    { provide: CUSTOMER_CONFIRMATION_NOTIFIER, useClass: LoggingCustomerConfirmationNotifier },
    RecoveryService,
    // #76 adoption — SpineRecoveryNotifier routes through the real notification spine.
    { provide: RECOVERY_NOTIFIER, useClass: SpineRecoveryNotifier },
    InstallService,
    InstallLifecycleService,
    // #76 adoption — SpineInstallNotifier routes through the real notification spine.
    { provide: INSTALL_NOTIFIER, useClass: SpineInstallNotifier },
  ],
  exports: [
    TicketCreationService,
    TicketQueryService,
    // Exported although only this module's own controller injects it today — the #251 failure was the
    // mirror image (a provider left out of `exports` that another module consumed, which resolved
    // when the module booted alone and killed 122 specs the moment the real app assembled).
    SpecialTicketQueryService,
    AutoRecoveryService,
    RepeatEscalationService,
    TroubleshootSubmissionService,
    VehicleUnavailabilityService,
    VehicleReturnResumeService,
    NonOperationalService,
    RecoveryService,
    InstallService,
    InstallLifecycleService,
    // #338 — exported so the outbox sweep (`BusinessSweepSchedulerModule`) can deliver the install
    // and recovery events the outbox now carries through the very same ports these services use.
    INSTALL_NOTIFIER,
    RECOVERY_NOTIFIER,
  ],
})
export class TicketingModule {}
