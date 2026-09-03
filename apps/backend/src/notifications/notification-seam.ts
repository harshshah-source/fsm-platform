import type { $Enums } from '../generated/prisma/client';
import { resolvePushProvider } from './fcm-channel.gateway';
import {
  channelDeliveryStatus,
  type ChannelDeliveryOutcome,
  type ChannelDeliveryResult,
  type NotificationChannelGateway,
} from './notification-channel.gateway';

/**
 * Issue 218c — the programmatic notification-seam gate for the deployment-lifecycle catch-up window,
 * **re-pointed by #337**.
 *
 * The window force-closes ~4,383 open tickets and creates ~1,100 more in a single transaction.
 * Nothing on the departure, restore or ticket-creation path calls a notifier (traced across 9
 * consumer files for the FIX-PLAN §7.2 inventory), and even if one did, the bound external gateway
 * was inert. That was verified by hand on 2026-08-07 — a verification that expires silently the
 * moment a real adapter lands — so it became this assertion, run by the window procedure at window
 * time.
 *
 * **What changed in #337.** The original invariant was "the binding must be `LoggingChannelGateway`",
 * which was the right shape while no other implementation existed and is the wrong one now that FCM
 * does. It would fail the window for the mere existence of an adapter class that nobody has switched
 * on, and — the worse direction — it would keep passing for any real provider that happened to
 * subclass or impersonate the inert one. The property actually worth defending is **no real provider
 * unless somebody explicitly configured one**, checked in three layers, in this order:
 *
 *   1. **configuration** — `PUSH_PROVIDER` names a real provider → breach. Nothing is constructed and
 *      nothing is called: a process configured for live delivery must not run this window whatever
 *      object it happens to be holding.
 *   2. **self-declaration** — the bound gateway does not declare `sendsExternally === false` → breach,
 *      **without probing**. Probing an unknown adapter to discover whether it sends is itself the send
 *      this gate exists to prevent, and an adapter that never considered the question is not making a
 *      claim of inertness by staying quiet.
 *   3. **behaviour** — only the gateway that declares itself inert is called, and then on every
 *      external channel, because a gateway whose behaviour changed under an unchanged declaration
 *      would otherwise pass on its word alone.
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
  /** The configured push provider — `logging` is the only value that can pass (#337). */
  pushProvider: string;
  channelsProbed: $Enums.NotificationChannel[];
  results: ChannelDeliveryResult[];
}

/**
 * Assert that no real external-delivery provider is configured or bound. Returns a report for the
 * window log, or throws {@link NotificationSeamBreachError} — never returns a falsy "not ok", so a
 * caller cannot forget to check it.
 *
 * `env` is a parameter so the check is testable against a configured provider without a test having
 * to mutate the process it runs in.
 */
export function assertNotificationSeamInert(
  gateway: unknown,
  env: NodeJS.ProcessEnv = process.env,
): NotificationSeamReport {
  const name = (gateway as { constructor?: { name?: string } })?.constructor?.name ?? String(gateway);

  // 1. Configuration — FIRST, before anything is constructed or touched. An unreadable value throws
  // out of `resolvePushProvider` and is re-raised as a breach: a configuration nobody can read is not
  // a configuration anyone should run a mass close under.
  let pushProvider: string;
  try {
    pushProvider = resolvePushProvider(env);
  } catch (e) {
    throw new NotificationSeamBreachError(
      `PUSH_PROVIDER could not be read: ${e instanceof Error ? e.message : String(e)} The #218c catch-up ` +
        `window MUST NOT run under a push configuration that cannot be interpreted.`,
    );
  }
  if (pushProvider !== 'logging') {
    throw new NotificationSeamBreachError(
      `PUSH_PROVIDER is "${pushProvider}" — a real external delivery provider is explicitly configured. ` +
        `The #218c catch-up window closes thousands of tickets in one transaction and MUST NOT run until ` +
        `the ticket-closure path has been reviewed against live delivery. Set PUSH_PROVIDER=logging for ` +
        `the window, or review the path first.`,
    );
  }

  // 2. Self-declaration — still without touching `deliver`. Undeclared counts as "sends".
  if ((gateway as NotificationChannelGateway | null)?.sendsExternally !== false) {
    throw new NotificationSeamBreachError(
      `NOTIFICATION_CHANNEL_GATEWAY is bound to ${name}, which does not declare itself inert ` +
        `(\`sendsExternally === false\`). Either a real adapter has landed on this binding, or an adapter ` +
        `that never answered the question is bound — and silence is not a claim of inertness. The #218c ` +
        `catch-up window closes thousands of tickets in one transaction and MUST NOT run until the ` +
        `ticket-closure path has been reviewed against live delivery. Refusing to probe ${name} — calling ` +
        `it to find out would be the send itself.`,
    );
  }

  // 3. Behaviour — only now, and only on a binding that declared itself inert. `deliver` is declared
  // `Promise<ChannelDeliveryOutcome> | ChannelDeliveryOutcome`; an async override makes the status
  // read below come back `undefined`, which is the safe direction — a gateway we cannot synchronously
  // prove inert is treated as not inert.
  const channelsProbed = [...EXTERNAL_CHANNELS];
  const results: ChannelDeliveryResult[] = [];
  for (const channel of channelsProbed) {
    const outcome: ChannelDeliveryOutcome | Promise<ChannelDeliveryOutcome> = (
      gateway as NotificationChannelGateway
    ).deliver({
      channel,
      recipientUserId: '00000000-0000-0000-0000-000000000000',
      recipientRole: 'SEAM_PROBE',
      type: 'ISSUE_218C_SEAM_PROBE',
      title: 'pre-window seam probe — not a real notification',
      body: null,
      entityType: null,
      entityId: null,
      metadata: null,
    });
    // #337 widened the return type to an optional detail object, so the comparison reads the status
    // rather than the whole value — otherwise `{ status: 'UNAVAILABLE' }` would read as a breach and
    // `{ status: 'SENT' }` would be caught only by accident.
    const result = outcome instanceof Promise ? undefined : channelDeliveryStatus(outcome);
    if (result !== 'UNAVAILABLE') {
      throw new NotificationSeamBreachError(
        `${name}.deliver({ channel: ${channel} }) returned ${describe(outcome)}, expected UNAVAILABLE. The ` +
          `gateway declares itself inert but no longer behaves inertly, so external delivery may be live. ` +
          `The #218c window MUST NOT run.`,
      );
    }
    results.push(result);
  }

  return { gateway: name, pushProvider, channelsProbed, results };
}

/** A gateway's answer, rendered for an operator reading a failed preflight at 05:30. */
function describe(outcome: unknown): string {
  if (outcome instanceof Promise) return 'a Promise (an async gateway cannot be proven inert synchronously)';
  if (typeof outcome === 'string') return outcome;
  try {
    return JSON.stringify(outcome);
  } catch {
    return String(outcome);
  }
}
