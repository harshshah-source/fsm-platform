import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { CrossZoneController } from './cross-zone.controller';
import { CrossZoneEscalationService } from './cross-zone-escalation.service';

/**
 * Cross-zone capacity allocation (Issue 32). Platinum auto-escalation + ZM manual flag → the CSM/OH
 * `/cross-zone` queue, with Approve (cross-zone Formal Assignment via SchedulingModule `OverrideService`),
 * Deny, Defer, and the denied-AUTO → Operations-Head re-escalation. ZM decisions are notified over the
 * NotificationsModule spine.
 */
@Module({
  imports: [PrismaModule, AuthModule, AuditModule, SchedulingModule, NotificationsModule],
  providers: [CrossZoneEscalationService],
  controllers: [CrossZoneController],
  exports: [CrossZoneEscalationService],
})
export class CrossZoneModule {}
