import { Injectable, Logger } from '@nestjs/common';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';

/** Emitted when a Recovery Ticket auto-closes on warehouse receipt — SE + ZM are notified (AC#4). */
export interface RecoveryClosedEvent {
  ticketId: string;
  deviceId: string;
  seId: string | null;
}

/** Emitted when an SE reports Unable to Collect — routes the ticket to the ZM decision queue. */
export interface RecoveryUnableToCollectEvent {
  ticketId: string;
  deviceId: string;
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
  deviceId: string;
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

/**
 * #76 — adoption. `recoveryClosed` has one recipient (the assigned SE), a no-op when `seId` is
 * null. `unableToCollect` routes to "the ZM decision queue" (per its own doc comment) but the event
 * itself carries no zone, so the recipient is resolved here via ticket → plant → zone (same lookup
 * shape `IntradayInsertionService.escalateToZm` already uses) — a no-op if the zone has no ZM set.
 * `escalatedToOh` deliberately stays on the Logging stub's own logging-only behavior — no "notify
 * Operations Head" recipient-resolution precedent exists anywhere in this codebase (broadcast vs. a
 * single designated OH is a product decision), so wiring it here would be inventing one, not
 * adopting an existing seam.
 */
@Injectable()
export class SpineRecoveryNotifier implements RecoveryNotifier {
  private readonly logger = new Logger('RecoveryNotifier');

  constructor(
    private readonly notifications: NotificationService,
    private readonly prisma: PrismaService,
  ) {}

  async recoveryClosed(event: RecoveryClosedEvent): Promise<void> {
    if (!event.seId) return;
    await this.notifications.notify({
      recipients: [{ userId: event.seId, role: 'SERVICE_ENGINEER' }],
      type: 'RECOVERY_CLOSED',
      title: 'Recovery closed',
      body: 'Ticket recovered and closed on warehouse receipt.',
      entityType: 'ticket',
      entityId: event.ticketId,
    });
  }

  async unableToCollect(event: RecoveryUnableToCollectEvent): Promise<void> {
    const ticket = await this.prisma.ticket.findUnique({ where: { ticketId: event.ticketId }, select: { plantId: true } });
    if (!ticket) return;
    const plant = await this.prisma.plant.findUnique({ where: { plantId: ticket.plantId }, select: { zoneId: true } });
    const zone = plant ? await this.prisma.zone.findUnique({ where: { zoneId: plant.zoneId }, select: { zonalManagerUserId: true } }) : null;
    if (!zone?.zonalManagerUserId) return;

    await this.notifications.notify({
      recipients: [{ userId: zone.zonalManagerUserId, role: 'ZONAL_MANAGER' }],
      type: 'RECOVERY_UNABLE_TO_COLLECT',
      title: 'Recovery: unable to collect',
      body: `Device ${event.deviceId} could not be collected (${event.reasonCode}). Decision needed.`,
      entityType: 'ticket',
      entityId: event.ticketId,
    });
  }

  /** Not wired to the spine — see the class doc comment. Kept logging so behavior doesn't silently
   *  regress to nothing once this class replaces `LoggingRecoveryNotifier` as the DI default. */
  escalatedToOh(event: RecoveryEscalatedEvent): void {
    this.logger.log(`Recovery escalated to Operations Head by ${event.escalatedByRole} — ticket=${event.ticketId} device=${event.deviceId}`);
  }
}
