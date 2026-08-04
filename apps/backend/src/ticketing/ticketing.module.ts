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
import { TroubleshootSubmissionService } from './troubleshoot-submission.service';
import { VehicleUnavailabilityService } from './vehicle-unavailability.service';

/**
 * Ticketing (Issue 05). The TROUBLESHOOT spine: `TicketCreationService` turns newly-inactive
 * eligible `device_states` into Failure Cycles + Tickets, and `TicketQueryService` backs the
 * `/api/tickets/*` read surface (`TicketsController` is registered in AppModule alongside the shared
 * guards, mirroring `SnapshotsController`). Install/Recovery work types and the SE-facing Day Plan /
 * Shared Pool surfaces are layered on by later issues.
 */
@Module({
  imports: [PrismaModule, AuditModule, SharedPoolModule, NotificationsModule],
  providers: [
    TicketCreationService,
    TicketQueryService,
    AutoRecoveryService,
    RepeatEscalationService,
    TroubleshootSubmissionService,
    VehicleUnavailabilityService,
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
    AutoRecoveryService,
    RepeatEscalationService,
    TroubleshootSubmissionService,
    VehicleUnavailabilityService,
    NonOperationalService,
    RecoveryService,
    InstallService,
    InstallLifecycleService,
  ],
})
export class TicketingModule {}
