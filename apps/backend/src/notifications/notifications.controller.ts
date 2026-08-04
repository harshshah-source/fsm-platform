import { BadRequestException, Body, Controller, Get, Headers, HttpCode, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { DeviceTokenService } from './device-token.service';
import { type NotificationList, NotificationService } from './notification.service';

/**
 * `/api/notifications` — the signed-in user's in-app notification list + read state (Issue 03). Any
 * authenticated user sees only their own notifications (the in-app channel that always fires).
 */
@Controller('notifications')
@UseGuards(AuthGuard, RoleGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly deviceTokens: DeviceTokenService,
  ) {}

  @Get()
  list(@CurrentUser() user: AccessTokenClaims, @Query('unread') unread?: string): Promise<NotificationList> {
    return this.notifications.listForUser(user.user_id, { unreadOnly: unread === 'true' });
  }

  @Post('read-all')
  @HttpCode(200)
  async markAllRead(@CurrentUser() user: AccessTokenClaims): Promise<{ updated: number }> {
    return { updated: await this.notifications.markAllRead(user.user_id) };
  }

  @Post(':id/read')
  @HttpCode(200)
  async markRead(@CurrentUser() user: AccessTokenClaims, @Param('id') id: string): Promise<{ ok: true }> {
    if (!/^\d+$/.test(id)) throw new BadRequestException({ code: 'INVALID_NOTIFICATION_ID' });
    const ok = await this.notifications.markRead(user.user_id, BigInt(id));
    if (!ok) throw new NotFoundException({ code: 'NOTIFICATION_NOT_FOUND' });
    return { ok: true };
  }

  /** #76 — the mobile push client (#89) registers its FCM token here on login; `AuthService.logout`
   *  clears it. `X-Device-Id` is already sent on every mobile request (#54 non-retrofittable). */
  @Post('device-token')
  @Roles('SERVICE_ENGINEER')
  async registerDeviceToken(
    @CurrentUser() user: AccessTokenClaims,
    @Headers('x-device-id') deviceId: string | undefined,
    @Body() body: { token?: string },
  ): Promise<{ ok: true }> {
    if (!deviceId) throw new BadRequestException({ code: 'DEVICE_ID_REQUIRED' });
    if (!body.token?.trim()) throw new BadRequestException({ code: 'TOKEN_REQUIRED' });
    await this.deviceTokens.register(user.user_id, body.token.trim(), deviceId);
    return { ok: true };
  }
}
