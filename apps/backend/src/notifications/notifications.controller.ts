import { BadRequestException, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { type NotificationList, NotificationService } from './notification.service';

/**
 * `/api/notifications` — the signed-in user's in-app notification list + read state (Issue 03). Any
 * authenticated user sees only their own notifications (the in-app channel that always fires).
 */
@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

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
}
