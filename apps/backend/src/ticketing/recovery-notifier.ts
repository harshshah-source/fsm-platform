import { Logger } from '@nestjs/common';

/** Emitted when a Recovery Ticket auto-closes on warehouse receipt — SE + ZM are notified (AC#4). */
export interface RecoveryClosedEvent {
  ticketId: string;
  deviceId: bigint;
  seId: string | null;
}

/** Emitted when an SE reports Unable to Collect — routes the ticket to the ZM decision queue. */
export interface RecoveryUnableToCollectEvent {
  ticketId: string;
  deviceId: bigint;
  seId: string | null;
  reasonCode: string;
}

/**
 * Recovery-notification seam (Issue 36). The notification spine (Issue 03 — push/SMS/WhatsApp) isn't
 * built yet, so RecoveryService fires closure + unable-to-collect events through this port. Issue 03
 * swaps the default for the real multi-channel notifier; the contract stays unchanged.
 */
export interface RecoveryNotifier {
  recoveryClosed(event: RecoveryClosedEvent): Promise<void> | void;
  unableToCollect(event: RecoveryUnableToCollectEvent): Promise<void> | void;
}

export const RECOVERY_NOTIFIER = Symbol('RECOVERY_NOTIFIER');

/** Default port until the notification spine lands — logs the event so it's observable in dev. */
export class LoggingRecoveryNotifier implements RecoveryNotifier {
  private readonly logger = new Logger('RecoveryNotifier');
  recoveryClosed(event: RecoveryClosedEvent): void {
    this.logger.log(`Recovery closed on warehouse receipt — ticket=${event.ticketId} device=${event.deviceId} se=${event.seId ?? '—'}`);
  }
  unableToCollect(event: RecoveryUnableToCollectEvent): void {
    this.logger.log(`Recovery unable-to-collect (${event.reasonCode}) → ZM decision queue — ticket=${event.ticketId} device=${event.deviceId}`);
  }
}
