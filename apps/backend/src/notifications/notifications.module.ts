import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DeviceTokenService } from './device-token.service';
import { createChannelGateway } from './fcm-channel.gateway';
import { NOTIFICATION_CHANNEL_GATEWAY } from './notification-channel.gateway';
import { NotificationService } from './notification.service';

/**
 * Notification spine (Issue 03). Provides `NotificationService` (in-app always-fires + the
 * push→SMS→WhatsApp→email fallback chain) over the `NOTIFICATION_CHANNEL_GATEWAY` seam, and
 * `DeviceTokenService` (Issue 76's push device-token registry) — both exported so producers can adopt
 * the spine and `AuthModule` can clear a token on logout. `NotificationsController` (in-app list/read
 * + device-token registration) stays registered directly on `AppModule`, unchanged.
 *
 * **#337 — the gateway is now chosen by configuration, and the default is unchanged.** `PUSH_PROVIDER`
 * unset or `logging` binds the inert `LoggingChannelGateway` exactly as this line always did; `fcm`
 * binds the real FCM HTTP v1 adapter. The switch lives in `createChannelGateway` rather than here so
 * that the "what is bound, and why" decision — including its refusal to arm without credentials — is
 * one testable function instead of a `useFactory` body nobody can call.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    NotificationService,
    DeviceTokenService,
    {
      provide: NOTIFICATION_CHANNEL_GATEWAY,
      useFactory: (deviceTokens: DeviceTokenService) => createChannelGateway({ deviceTokens }),
      inject: [DeviceTokenService],
    },
  ],
  exports: [NotificationService, DeviceTokenService],
})
export class NotificationsModule {}
