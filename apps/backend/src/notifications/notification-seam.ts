import type { $Enums } from '../generated/prisma/client';
import { LoggingChannelGateway, type ChannelDeliveryResult } from './notification-channel.gateway';

/**
 * Issue 218c — the programmatic notification-seam gate for the deployment-lifecycle catch-up window.
 *
 * The window force-closes ~4,383 open tickets and creates ~1,100 more in a single transaction. Nothing
 * on the departure, restore or ticket-creation path calls a notifier (traced across 9 consumer files
 * for the FIX-PLAN §7.2 inventory), and even if one did, `notifications.module.ts` binds
 * {@link NOTIFICATION_CHANNEL_GATEWAY} to {@link LoggingChannelGateway}, which returns `UNAVAILABLE`
 * for every external channel. **That single binding is the only thing standing between this catch-up
 * and a mass send**, and it was verified by hand on 2026-08-07 — a verification that expires silently
 * the moment the real FCM/APNs/SMS/WhatsApp/SMTP adapters land. This turns it into an assertion the
 * window procedure runs at window time.
 *
 * **Identity is checked before behaviour, and that ordering is the safety property.** An unrecognised
 * gateway is rejected *without being invoked*: probing an unknown adapter to discover whether it sends
 * is itself the send this gate exists to prevent. Only the known-inert binding is ever called, and it
 * is then probed on every external channel — because a same-class gateway whose behaviour changed
 * would otherwise pass on its name alone.
 */

/** Every channel that leaves the building. `IN_APP` is excluded: it is persisted directly by
 * `NotificationService` and never routed through the gateway, so it is not part of the send risk. */
export const EXTERNAL_CHANNELS: readonly $Enums.NotificationChannel[] = ['PUSH', 'SMS', 'WHATSAPP', 'EMAIL'];

/** Raised when the seam cannot be shown inert. Fatal by design — the window must not proceed. */
export class NotificationSeamBreachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationSeamBreachError';
  }
}

export interface NotificationSeamReport {
  /** Constructor name of the bound gateway, for the operator's window log. */
  gateway: string;
  channelsProbed: $Enums.NotificationChannel[];
  results: ChannelDeliveryResult[];
}

/**
 * Assert the bound external-delivery gateway cannot send. Returns a report for the window log, or
 * throws {@link NotificationSeamBreachError} — never returns a falsy "not ok", so a caller cannot
 * forget to check it.
 */
export function assertNotificationSeamInert(gateway: unknown): NotificationSeamReport {
  const name = (gateway as { constructor?: { name?: string } })?.constructor?.name ?? String(gateway);

  // 1. Identity — FIRST, and without touching `deliver`.
  if (!(gateway instanceof LoggingChannelGateway)) {
    throw new NotificationSeamBreachError(
      `NOTIFICATION_CHANNEL_GATEWAY is bound to ${name}, not the inert LoggingChannelGateway. Real ` +
        `external adapters appear to have landed since the 2026-08-07 verification. The #218c catch-up ` +
        `window closes thousands of tickets in one transaction and MUST NOT run until the ticket-closure ` +
        `path has been reviewed against live delivery. Refusing to probe ${name} — calling it to find ` +
        `out would be the send itself.`,
    );
  }

  // 2. Behaviour — only now, and only on the binding we recognise. `deliver` is declared
  // `Promise<ChannelDeliveryResult> | ChannelDeliveryResult`; an async override would make the
  // comparison below fail on a Promise object, which is the safe direction — a gateway we cannot
  // synchronously prove inert is treated as not inert.
  const channelsProbed = [...EXTERNAL_CHANNELS];
  const results: ChannelDeliveryResult[] = [];
  for (const channel of channelsProbed) {
    const result: ChannelDeliveryResult | Promise<ChannelDeliveryResult> = gateway.deliver({
      channel,
      recipientUserId: '00000000-0000-0000-0000-000000000000',
      recipientRole: 'SEAM_PROBE',
      type: 'ISSUE_218C_SEAM_PROBE',
      title: 'pre-window seam probe — not a real notification',
      body: null,
      metadata: null,
    });
    if (result !== 'UNAVAILABLE') {
      throw new NotificationSeamBreachError(
        `${name}.deliver({ channel: ${channel} }) returned ${String(result)}, expected UNAVAILABLE. The ` +
          `gateway carries the inert class identity but no longer behaves inertly, so external delivery ` +
          `may be live. The #218c window MUST NOT run.`,
      );
    }
    results.push(result);
  }

  return { gateway: name, channelsProbed, results };
}
