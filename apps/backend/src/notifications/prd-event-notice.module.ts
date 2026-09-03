import { Module } from '@nestjs/common';
import { ComponentRequestModule } from '../component-request/component-request.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CronTickClaimModule } from '../scheduling/cron-tick-claim.module';
import { CronTickClaimService } from '../scheduling/cron-tick-claim.service';
import { NotificationsModule } from './notifications.module';
import { NotificationService } from './notification.service';
import { ComponentRequestService } from '../component-request/component-request.service';
import { PrismaService } from '../prisma/prisma.service';
import { PrdEventNoticeService } from './prd-event-notice.service';

/**
 * #361 — a leaf module for the one tick that carries this slice's two condition-driven notices (the
 * 7-day waiting-component escalation, and the ingestion FAILED/overdue alert to the Operations Head).
 *
 * `ScheduleModule.forRoot()` is registered once (IngestionModule) and its explorer discovers `@Cron`
 * handlers across the whole container, so this module needs no schedule registration of its own —
 * exactly as `BusinessSweepSchedulerModule` documents.
 *
 * Factory-provided for the same reason that module is: the service's optional `config` parameter is
 * meant to read the environment, not to be DI-resolved. Nothing imports this module back, so it cannot
 * form a cycle.
 */
@Module({
  imports: [PrismaModule, NotificationsModule, ComponentRequestModule, CronTickClaimModule],
  providers: [
    {
      provide: PrdEventNoticeService,
      useFactory: (
        prisma: PrismaService,
        notifications: NotificationService,
        componentRequests: ComponentRequestService,
        claims: CronTickClaimService,
      ) => new PrdEventNoticeService(prisma, notifications, componentRequests, claims),
      inject: [PrismaService, NotificationService, ComponentRequestService, CronTickClaimService],
    },
  ],
  exports: [PrdEventNoticeService],
})
export class PrdEventNoticeModule {}
