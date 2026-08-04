import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DeviceTokenService } from './device-token.service';
import { LoggingChannelGateway, NOTIFICATION_CHANNEL_GATEWAY } from './notification-channel.gateway';
import { NotificationService } from './notification.service';

/**
 * Notification spine (Issue 03). Provides `NotificationService` (in-app always-fires + the
 * push→SMS→WhatsApp→email fallback chain + first-class SE-Acceptance WhatsApp) over the
 * `NOTIFICATION_CHANNEL_GATEWAY` seam (default `LoggingChannelGateway` until the external FCM/APNs/
 * WhatsApp/SMS/SMTP accounts land). Also provides `DeviceTokenService` (Issue 76's push
 * device-token registry) — both exported so producers can adopt the spine and `AuthModule` can
 * clear a token on logout. `NotificationsController` (in-app list/read + device-token
 * registration) stays registered directly on `AppModule`, unchanged.
 */
@Module({
  imports: [PrismaModule],
  providers: [NotificationService, DeviceTokenService, { provide: NOTIFICATION_CHANNEL_GATEWAY, useClass: LoggingChannelGateway }],
  exports: [NotificationService, DeviceTokenService],
})
export class NotificationsModule {}
