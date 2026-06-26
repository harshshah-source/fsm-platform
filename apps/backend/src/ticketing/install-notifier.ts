import { Logger } from '@nestjs/common';

/** Emitted when an Install Ticket's first valid post-fitment ping arrives — Ticket CLOSED, SE notified. */
export interface InstallVerifiedEvent {
  ticketId: string;
  deviceId: bigint;
  seId: string | null;
}

/** Emitted when no valid ping arrives within the activation window — FAILED_ACTIVATION, SE notified to
 *  return or escalate. */
export interface InstallFailedActivationEvent {
  ticketId: string;
  deviceId: bigint;
  seId: string | null;
}

/**
 * Install-notification seam (Issue 34). The notification spine (Issue 03 — push/SMS/WhatsApp) isn't
 * built yet, so the install auto-verification fires its "installation verified — Ticket CLOSED" and
 * "FAILED_ACTIVATION" pushes through this port. Issue 03 swaps the default for the real multi-channel
 * notifier; the contract stays unchanged. Mirrors `recovery-notifier.ts`.
 */
export interface InstallNotifier {
  installVerified(event: InstallVerifiedEvent): Promise<void> | void;
  failedActivation(event: InstallFailedActivationEvent): Promise<void> | void;
}

export const INSTALL_NOTIFIER = Symbol('INSTALL_NOTIFIER');

/** Default port until the notification spine lands — logs the event so it's observable in dev. */
export class LoggingInstallNotifier implements InstallNotifier {
  private readonly logger = new Logger('InstallNotifier');
  installVerified(event: InstallVerifiedEvent): void {
    this.logger.log(`Install verified — first ping in — ticket=${event.ticketId} device=${event.deviceId} se=${event.seId ?? '—'}`);
  }
  failedActivation(event: InstallFailedActivationEvent): void {
    this.logger.log(`Install FAILED_ACTIVATION — no ping in window — ticket=${event.ticketId} device=${event.deviceId} se=${event.seId ?? '—'}`);
  }
}
