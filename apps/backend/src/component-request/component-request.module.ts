import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ComponentRequestService } from './component-request.service';

/**
 * Component Request (Issue 22, ADR-0008, CONTEXT §8) — the component-unavailable loop: the Warehouse
 * Manager queue + Approve/Ship/Reject, SE Confirm Receipt with the SLA-resume switch, and the
 * ZM-confirmed resubmit binding (resume SLA, reopen cycle, apply resubmit ownership). The raise lives
 * in the troubleshoot submission (TicketingModule). `WarehouseRequestsController` /
 * `ComponentRequestController` are registered in AppModule.
 */
@Module({
  // #361 — for `NotificationService`: the WM legs enqueue the SE's notice in their own transaction and
  // deliver it post-commit, and the 7-day sweep resolves each zone's manager through it.
  imports: [PrismaModule, NotificationsModule],
  providers: [ComponentRequestService],
  exports: [ComponentRequestService],
})
export class ComponentRequestModule {}
