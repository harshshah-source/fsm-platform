import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LoggingChannelGateway, NOTIFICATION_CHANNEL_GATEWAY } from './notification-channel.gateway';
import { NotificationService } from './notification.service';

/**
 * Notification spine (Issue 03). Provides `NotificationService` (in-app always-fires + the
 * push→SMS→WhatsApp→email fallback chain + first-class SE-Acceptance WhatsApp) over the
 * `NOTIFICATION_CHANNEL_GATEWAY` seam (default `LoggingChannelGateway` until the external FCM/APNs/
 * WhatsApp/SMS/SMTP accounts land). Exported so producers can adopt it; `NotificationsController`
 * (in-app list/read) is registered in AppModule. Existing per-feature notifier seams are rewired
 * separately (not in this issue).
 */
@Module({
  imports: [PrismaModule],
  providers: [NotificationService, { provide: NOTIFICATION_CHANNEL_GATEWAY, useClass: LoggingChannelGateway }],
  exports: [NotificationService],
})
export class NotificationsModule {}
