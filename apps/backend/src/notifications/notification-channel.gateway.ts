import { Logger } from '@nestjs/common';
import { type NotificationChannel } from '../generated/prisma/enums';

/** Outcome of one external-channel send attempt. */
export type ChannelDeliveryResult = 'SENT' | 'FAILED' | 'UNAVAILABLE';

/**
 * The same outcome, with what the provider said about it (#337).
 *
 * A bare status was enough while every external channel was UNAVAILABLE for the same single reason
 * ("no adapter yet"). Once a real provider answers, one FAILED covers a stale token that was just
 * reaped, a 5xx the provider will recover from on its own, and a credential the operator has to go
 * and fix — three different situations with three different owners. `notification_deliveries` is
 * where somebody looks to ask "was this person told, and if not why not", so the detail is carried
 * here rather than left in a log line.
 */
export interface ChannelDeliveryDetail {
  status: ChannelDeliveryResult;
  /** The provider's own handle for the send — what an operator quotes when asking FCM about one push. */
  providerMessageId?: string | null;
  /** Why a FAILED (or a non-obvious UNAVAILABLE) came out that way, in one sentence. */
  error?: string | null;
  /**
   * Whether a later attempt could plausibly succeed. Advisory, and deliberately not acted on inside
   * `NotificationService`: retry policy belongs to the durable outbox (#338), which is the only layer
   * that knows whether re-delivering would duplicate the notice. See the #337 report.
   */
  retryable?: boolean;
}

/** What a gateway may return: the bare status it always could, or the detail (#337). */
export type ChannelDeliveryOutcome = ChannelDeliveryResult | ChannelDeliveryDetail;

/** Narrow either shape to the status. */
export function channelDeliveryStatus(outcome: ChannelDeliveryOutcome): ChannelDeliveryResult {
  return typeof outcome === 'string' ? outcome : outcome.status;
}

/** Normalise either shape to the detail, so call sites handle one thing. */
export function channelDeliveryDetail(outcome: ChannelDeliveryOutcome): ChannelDeliveryDetail {
  return typeof outcome === 'string' ? { status: outcome } : outcome;
}

export interface ChannelSendInput {
  channel: NotificationChannel;
  recipientUserId: string;
  recipientRole: string;
  type: string;
  title: string;
  body?: string | null;
  /**
   * What the notice is about (#337). Push payloads carry `data: { type, entityId }` so the handset
   * can route the tap to the thing itself rather than to a generic list — #85's Notifications screen
   * already routes on `entityType === 'ticket'`, and a push that drops the id makes every notification
   * a dead end.
   */
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * The external delivery seam for the notification spine (Issue 03). SMS, WhatsApp Business and SMTP
 * still need external accounts + (WhatsApp) template approval — the HITL part of that issue — so those
 * adapters remain deferred. **Push is no longer deferred (#337):** `FcmChannelGateway` is a complete
 * FCM HTTP v1 adapter, bound when `PUSH_PROVIDER=fcm` names it and inert otherwise.
 * `NotificationService` owns the fallback-chain logic and the per-channel status recording; it calls
 * this port for the actual send.
 */
export interface NotificationChannelGateway {
  deliver(input: ChannelSendInput): Promise<ChannelDeliveryOutcome> | ChannelDeliveryOutcome;
  /**
   * Whether this gateway can reach anything outside the building (#337).
   *
   * Declared, not inferred, and **undeclared means "assume it sends"**. The #218c pre-window gate
   * (`notification-seam.ts`) has to decide whether a mass close can safely run, and it must reach that
   * decision without calling `deliver` — probing an unknown adapter to find out whether it sends is
   * itself the send the gate exists to prevent. So an adapter says so about itself, and silence is
   * never read as a claim of inertness.
   */
  readonly sendsExternally?: boolean;
}

export const NOTIFICATION_CHANNEL_GATEWAY = Symbol('NOTIFICATION_CHANNEL_GATEWAY');

/**
 * The inert default: external channels are UNAVAILABLE (the fallback chain records each as ATTEMPTED
 * and falls through), logged so dev can observe intent. Still the binding unless an operator sets
 * `PUSH_PROVIDER=fcm`. IN_APP is never routed here — `NotificationService` always persists the in-app
 * notification directly.
 */
export class LoggingChannelGateway implements NotificationChannelGateway {
  readonly sendsExternally = false;
  private readonly logger = new Logger('NotificationChannelGateway');
  deliver(input: ChannelSendInput): ChannelDeliveryResult {
    this.logger.log(`[seam] ${input.channel} → user=${input.recipientUserId} type=${input.type} title="${input.title}" (no adapter yet)`);
    return 'UNAVAILABLE';
  }
}
