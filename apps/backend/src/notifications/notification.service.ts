import { Inject, Injectable, Optional } from '@nestjs/common';
import { type NotificationChannel, type Role } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import {
  type NotificationChannelGateway,
  NOTIFICATION_CHANNEL_GATEWAY,
  LoggingChannelGateway,
} from './notification-channel.gateway';

/**
 * GENERAL → push/SMS/WhatsApp/email fallback (in-app always fires too); SE_ACCEPTANCE → in-app + the
 * first-class WhatsApp Confirmation (shown as "sent").
 */
export type NotificationDeliveryModel = 'GENERAL' | 'SE_ACCEPTANCE';

export interface NotifyRecipient {
  userId: string;
  role: Role;
}

export interface NotifyInput {
  recipients: NotifyRecipient[];
  type: string;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Defaults to GENERAL (the fallback chain). */
  deliveryModel?: NotificationDeliveryModel;
}

export interface DeliveryView {
  channel: NotificationChannel;
  status: 'SENT' | 'ATTEMPTED' | 'SKIPPED' | 'FAILED';
  firstClass: boolean;
}
export interface NotificationView {
  id: string;
  recipientUserId: string;
  type: string;
  title: string;
  deliveries: DeliveryView[];
}

export interface NotificationListItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}
export interface NotificationList {
  items: NotificationListItem[];
  unreadCount: number;
}

/** The general-notification fallback chain, in order. IN_APP is handled separately (always fires). */
const GENERAL_CHAIN: NotificationChannel[] = ['PUSH', 'SMS', 'WHATSAPP', 'EMAIL'];

/**
 * The notification spine (Issue 03). `notify` writes one Notification per recipient — the in-app
 * notification ALWAYS fires (AC#1) — and records each channel's delivery. GENERAL notifications walk the
 * push→SMS→WhatsApp→email fallback chain, stopping at the first channel the gateway reports SENT and
 * recording the rest as ATTEMPTED (AC#2). SE_ACCEPTANCE delivers the WhatsApp Confirmation as a first-class
 * channel recorded SENT (shown as "sent", not "attempted") alongside in-app (AC#3). The actual external
 * send is the deferred `NotificationChannelGateway` seam (FCM/APNs/WhatsApp/SMS/SMTP = HITL accounts).
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(NOTIFICATION_CHANNEL_GATEWAY) private readonly gateway: NotificationChannelGateway = new LoggingChannelGateway(),
  ) {}

  async notify(input: NotifyInput): Promise<NotificationView[]> {
    const out: NotificationView[] = [];
    for (const recipient of input.recipients) {
      out.push(await this.notifyOne(recipient, input));
    }
    return out;
  }

  /** The signed-in user's in-app notifications, newest first (AC#1). `unreadOnly` filters to unread. */
  async listForUser(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<NotificationList> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
    const where = { recipientUserId: userId, ...(opts.unreadOnly ? { inAppReadAt: null } : {}) };
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
      this.prisma.notification.count({ where: { recipientUserId: userId, inAppReadAt: null } }),
    ]);
    return {
      items: rows.map((n) => ({
        id: String(n.id),
        type: n.type,
        title: n.title,
        body: n.body,
        entityType: n.entityType,
        entityId: n.entityId,
        metadata: n.metadata,
        read: n.inAppReadAt !== null,
        readAt: n.inAppReadAt ? n.inAppReadAt.toISOString() : null,
        createdAt: n.createdAt.toISOString(),
      })),
      unreadCount,
    };
  }

  /** Mark one notification read — only the owner's own (returns false if not found / not theirs). */
  async markRead(userId: string, id: bigint, now: Date = new Date()): Promise<boolean> {
    const res = await this.prisma.notification.updateMany({
      where: { id, recipientUserId: userId, inAppReadAt: null },
      data: { inAppReadAt: now },
    });
    if (res.count > 0) return true;
    // Distinguish "already read" (still owned → success) from "not yours / missing" (false).
    const owned = await this.prisma.notification.findFirst({ where: { id, recipientUserId: userId }, select: { id: true } });
    return owned !== null;
  }

  /** Mark all of the user's unread notifications read; returns how many were updated. */
  async markAllRead(userId: string, now: Date = new Date()): Promise<number> {
    const res = await this.prisma.notification.updateMany({ where: { recipientUserId: userId, inAppReadAt: null }, data: { inAppReadAt: now } });
    return res.count;
  }

  private async notifyOne(recipient: NotifyRecipient, input: NotifyInput): Promise<NotificationView> {
    const notification = await this.prisma.notification.create({
      data: {
        recipientUserId: recipient.userId,
        recipientRole: recipient.role,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        metadata: (input.metadata ?? undefined) as object | undefined,
      },
    });

    const deliveries: DeliveryView[] = [{ channel: 'IN_APP', status: 'SENT', firstClass: false }];
    const send = (channel: NotificationChannel) =>
      this.gateway.deliver({
        channel,
        recipientUserId: recipient.userId,
        recipientRole: recipient.role,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        metadata: input.metadata ?? null,
      });

    if ((input.deliveryModel ?? 'GENERAL') === 'SE_ACCEPTANCE') {
      // WhatsApp Confirmation is first-class for SE Acceptance — committed as SENT (shown as "sent").
      await send('WHATSAPP');
      deliveries.push({ channel: 'WHATSAPP', status: 'SENT', firstClass: true });
    } else {
      for (const channel of GENERAL_CHAIN) {
        const result = await send(channel);
        if (result === 'SENT') {
          deliveries.push({ channel, status: 'SENT', firstClass: false });
          break;
        }
        deliveries.push({ channel, status: 'ATTEMPTED', firstClass: false });
      }
    }

    await this.prisma.notificationDelivery.createMany({
      data: deliveries.map((d) => ({ notificationId: notification.id, channel: d.channel, status: d.status, firstClass: d.firstClass })),
    });

    return {
      id: String(notification.id),
      recipientUserId: notification.recipientUserId,
      type: notification.type,
      title: notification.title,
      deliveries,
    };
  }
}
