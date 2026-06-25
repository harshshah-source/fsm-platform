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
/** Emitted when a ZM escalates an unable-to-collect Recovery Ticket to Operations Head (Issue 37). */
export interface RecoveryEscalatedEvent {
  ticketId: string;
  deviceId: bigint;
  escalatedByRole: string;
}

export interface RecoveryNotifier {
  recoveryClosed(event: RecoveryClosedEvent): Promise<void> | void;
  unableToCollect(event: RecoveryUnableToCollectEvent): Promise<void> | void;
  /** Optional — escalation to Operations Head (Issue 37); older stubs may omit it. */
  escalatedToOh?(event: RecoveryEscalatedEvent): Promise<void> | void;
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
  escalatedToOh(event: RecoveryEscalatedEvent): void {
    this.logger.log(`Recovery escalated to Operations Head by ${event.escalatedByRole} — ticket=${event.ticketId} device=${event.deviceId}`);
  }
}
