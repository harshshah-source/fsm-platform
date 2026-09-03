import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { type NotificationChannel, type Role } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import {
  type NotificationChannelGateway,
  NOTIFICATION_CHANNEL_GATEWAY,
  LoggingChannelGateway,
} from './notification-channel.gateway';

/**
 * How a notice is delivered: in-app always fires, then the push/SMS/WhatsApp/email fallback chain.
 *
 * #356 (NOTIF-05) — `SE_ACCEPTANCE` is gone. It delivered WhatsApp as a "first-class" confirmation for
 * the SE Acceptance step, and CONTEXT §21 retired SE Acceptance itself (#268/#279): a CRITICAL ticket
 * is assigned directly, so there is no acceptance to confirm and no producer had passed the model in
 * over a year. The union is kept as a single-member type rather than deleted outright so the call
 * sites that spell `deliveryModel: 'GENERAL'` keep saying which model they mean — and so a future
 * second model (#337's push work is the candidate) has somewhere to land.
 */
export type NotificationDeliveryModel = 'GENERAL';

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

const logger = new Logger('NotificationService');

/**
 * #354 — who to tell, named by role (and optionally by zone) rather than by a single stored id.
 *
 * `zoneId` omitted means "anyone holding the role, in any zone" (the pan-India roles: CSM, Operations
 * Head). `zoneId` set clamps to that zone's holders.
 */
export interface RecipientsInRolesQuery {
  role: Role | Role[];
  zoneId?: number | bigint | null;
}

/**
 * The notification spine (Issue 03). `notify` writes one Notification per recipient — the in-app
 * notification ALWAYS fires (AC#1) — and records each channel's delivery. Notices walk the
 * push→SMS→WhatsApp→email fallback chain, stopping at the first channel the gateway reports SENT and
 * recording the rest as ATTEMPTED (AC#2). The actual external send is the deferred
 * `NotificationChannelGateway` seam (FCM/APNs/WhatsApp/SMS/SMTP = HITL accounts).
 *
 * #356 removed the second delivery model (`SE_ACCEPTANCE`, the first-class WhatsApp Confirmation of
 * Issue 03 AC#3) along with the SE Acceptance step CONTEXT §21 retired. `notification_deliveries`
 * still carries its `first_class` column, now written at its `false` default by everything — dropping
 * the column is a migration this slice deliberately did not take (see the report).
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

  /**
   * #354 — resolve a notice's recipients from the **role** that owns the decision, not from one stored
   * user id, and say so out loud when the role is vacant.
   *
   * Every producer that had to tell "the ZM of zone X" read `zones.zonal_manager_user_id` and returned
   * silently when it was null: a zone between managers, or one whose ZM was never linked, simply got
   * no notice — with nothing in the log to say a notice had been dropped. A vacancy is an operational
   * fact somebody has to see, so an empty result is logged as `NO_RECIPIENT` here, once, at the single
   * place that can know it happened.
   *
   * Takes a client so it can resolve **inside** the producing transaction (#338's rows record the
   * recipients they resolved, which is what lets a row answer "who was told" afterwards).
   */
  async recipientsInRoles(
    query: RecipientsInRolesQuery,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<NotifyRecipient[]> {
    const roles = Array.isArray(query.role) ? query.role : [query.role];
    const zoneId = query.zoneId == null ? null : BigInt(query.zoneId);
    const users = await client.user.findMany({
      where: { role: { in: roles }, status: 'ACTIVE', ...(zoneId !== null ? { zoneId } : {}) },
      select: { userId: true, role: true },
    });
    if (users.length === 0) {
      logger.warn(`NO_RECIPIENT roles=${roles.join('|')} zone=${zoneId !== null ? String(zoneId) : 'any'}`);
    }
    return users.map((u) => ({ userId: u.userId, role: u.role }));
  }

  /**
   * #356 (AC4) — who a zone's news goes to, in one place.
   *
   * The designated `zones.zonal_manager_user_id` when there is one: that is the accountable manager,
   * and a zone that names one does not want its news fanned out to everybody who happens to hold the
   * role there. When there is none — a zone between managers, or one never linked — the role itself
   * answers, and {@link recipientsInRoles} logs the miss if *that* is empty too. The one thing this
   * must never do is what its three call sites used to: read the id, find null, and return nothing,
   * quietly, leaving an escalation ledger row that looks exactly like one a manager has already seen.
   *
   * Promoted here from `cross-zone-escalation.service.ts`, where #354 first wrote it privately. Three
   * producers now ask this question — cross-zone escalation, the CRITICAL intra-day sweep and
   * stranded-work escalation — and three private copies of a fallback policy is how the policies drift
   * apart. Takes a client so it can resolve **inside** the producing transaction, for #338's reason:
   * the outbox row must record the recipients the transaction saw.
   */
  async zoneManagerRecipients(
    zoneId: number | bigint,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<NotifyRecipient[]> {
    const id = BigInt(zoneId);
    const zone = await client.zone.findUnique({ where: { zoneId: id } });
    if (zone?.zonalManagerUserId) return [{ userId: zone.zonalManagerUserId, role: 'ZONAL_MANAGER' }];
    return this.recipientsInRoles({ role: 'ZONAL_MANAGER', zoneId: id }, client);
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

    const deliveries: DeliveryView[] = [{ channel: 'IN_APP', status: 'SENT' }];
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

    // #76, kept when #356 deleted the branch it was written for: `notification_deliveries.status`
    // records what actually happened. A delivery that provably did not occur is a false record in the
    // audit trail, not a harmless simplification — the whole point of the table is that somebody can
    // afterwards ask "was this person actually told?" and get a truthful answer.
    for (const channel of GENERAL_CHAIN) {
      const result = await send(channel);
      if (result === 'SENT') {
        deliveries.push({ channel, status: 'SENT' });
        break;
      }
      deliveries.push({ channel, status: 'ATTEMPTED' });
    }

    await this.prisma.notificationDelivery.createMany({
      data: deliveries.map((d) => ({ notificationId: notification.id, channel: d.channel, status: d.status })),
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
