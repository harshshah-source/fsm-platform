import { Logger } from '@nestjs/common';
import { type NotificationChannel } from '../generated/prisma/enums';

/** Outcome of one external-channel send attempt. */
export type ChannelDeliveryResult = 'SENT' | 'FAILED' | 'UNAVAILABLE';

export interface ChannelSendInput {
  channel: NotificationChannel;
  recipientUserId: string;
  recipientRole: string;
  type: string;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * The external delivery seam for the notification spine (Issue 03). The push (FCM/APNs), SMS, WhatsApp
 * Business, and SMTP gateways need external accounts + (WhatsApp) template approval — the HITL part of
 * this issue — so the real adapters are deferred. `NotificationService` owns the fallback-chain logic and
 * the per-channel status recording; it calls this port for the actual send. Swap the default for real
 * adapters when the accounts land; the contract stays unchanged.
 */
export interface NotificationChannelGateway {
  deliver(input: ChannelSendInput): Promise<ChannelDeliveryResult> | ChannelDeliveryResult;
}

export const NOTIFICATION_CHANNEL_GATEWAY = Symbol('NOTIFICATION_CHANNEL_GATEWAY');

/**
 * Default gateway until the external accounts are provisioned: external channels are UNAVAILABLE (the
 * fallback chain records each as ATTEMPTED and falls through), logged so dev can observe intent. IN_APP is
 * never routed here — `NotificationService` always persists the in-app notification directly.
 */
export class LoggingChannelGateway implements NotificationChannelGateway {
  private readonly logger = new Logger('NotificationChannelGateway');
  deliver(input: ChannelSendInput): ChannelDeliveryResult {
    this.logger.log(`[seam] ${input.channel} → user=${input.recipientUserId} type=${input.type} title="${input.title}" (no adapter yet)`);
    return 'UNAVAILABLE';
  }
}
