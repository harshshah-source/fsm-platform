import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { SeAvailabilityService } from '../engineers/se-availability.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RecommenderModule } from '../recommender/recommender.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { IntradayInsertionController } from './intraday-insertion.controller';
import { IntradayInsertionService } from './intraday-insertion.service';

/**
 * System-triggered intra-day CRITICAL insertion + SE Acceptance (Issues 29/30). The offer/accept/decline
 * state machine + the 10-min timeout reroute chain + 3-retry escalation. Composes the candidate-selection
 * precedence (RecommenderModule), the Day-Plan commit (SchedulingModule `OverrideService`), and the
 * notification spine (NotificationsModule) over the mutable `intraday_insertions` record.
 */
@Module({
  imports: [PrismaModule, AuthModule, AuditModule, RecommenderModule, SchedulingModule, NotificationsModule],
  providers: [IntradayInsertionService, SeAvailabilityService],
  controllers: [IntradayInsertionController],
  exports: [IntradayInsertionService],
})
export class IntradayModule {}
