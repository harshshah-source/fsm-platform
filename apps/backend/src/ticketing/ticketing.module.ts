import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AutoRecoveryService } from './auto-recovery.service';
import { RepeatEscalationService } from './repeat-escalation.service';
import { TicketCreationService } from './ticket-creation.service';
import { TicketQueryService } from './ticket-query.service';
import { TroubleshootSubmissionService } from './troubleshoot-submission.service';

/**
 * Ticketing (Issue 05). The TROUBLESHOOT spine: `TicketCreationService` turns newly-inactive
 * eligible `device_states` into Failure Cycles + Tickets, and `TicketQueryService` backs the
 * `/api/tickets/*` read surface (`TicketsController` is registered in AppModule alongside the shared
 * guards, mirroring `SnapshotsController`). Install/Recovery work types and the SE-facing Day Plan /
 * Shared Pool surfaces are layered on by later issues.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    TicketCreationService,
    TicketQueryService,
    AutoRecoveryService,
    RepeatEscalationService,
    TroubleshootSubmissionService,
  ],
  exports: [
    TicketCreationService,
    TicketQueryService,
    AutoRecoveryService,
    RepeatEscalationService,
    TroubleshootSubmissionService,
  ],
})
export class TicketingModule {}
