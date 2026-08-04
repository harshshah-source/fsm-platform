import { Injectable, Logger } from '@nestjs/common';
import { NotificationService } from '../notifications/notification.service';

/** Emitted when an Install Ticket's first valid post-fitment ping arrives — Ticket CLOSED, SE notified. */
export interface InstallVerifiedEvent {
  ticketId: string;
  deviceId: string;
  seId: string | null;
}

/** Emitted when no valid ping arrives within the activation window — FAILED_ACTIVATION, SE notified to
 *  return or escalate. */
export interface InstallFailedActivationEvent {
  ticketId: string;
  deviceId: string;
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

/** #76 — adoption. Both events have exactly one recipient — the assigned SE; a no-op (matching the
 *  Logging stub's own `'—'` "no SE" case) when `seId` is null. Messages mirror the #71 mobile
 *  Install card's own terminal-outcome copy for consistency. */
@Injectable()
export class SpineInstallNotifier implements InstallNotifier {
  constructor(private readonly notifications: NotificationService) {}

  async installVerified(event: InstallVerifiedEvent): Promise<void> {
    if (!event.seId) return;
    await this.notifications.notify({
      recipients: [{ userId: event.seId, role: 'SERVICE_ENGINEER' }],
      type: 'INSTALL_VERIFIED',
      title: 'Installation verified',
      body: 'Installation verified — ticket closed.',
      entityType: 'ticket',
      entityId: event.ticketId,
    });
  }

  async failedActivation(event: InstallFailedActivationEvent): Promise<void> {
    if (!event.seId) return;
    await this.notifications.notify({
      recipients: [{ userId: event.seId, role: 'SERVICE_ENGINEER' }],
      type: 'INSTALL_FAILED_ACTIVATION',
      title: 'Installation activation failed',
      body: 'No GPS ping received — activation failed.',
      entityType: 'ticket',
      entityId: event.ticketId,
    });
  }
}
