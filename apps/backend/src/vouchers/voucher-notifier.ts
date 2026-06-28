import { Logger } from '@nestjs/common';

/** A ZM review decision on an Expense Voucher — the SE is notified (PRD §29, AC#4). */
export interface VoucherReviewedEvent {
  voucherId: string;
  seId: string;
  action: 'APPROVE' | 'REJECT' | 'NEEDS_CLARIFICATION';
  notes: string | null;
}

/** An Operations-Head Mark-PAID on an APPROVED voucher — the SE is notified (PRD §59). */
export interface VoucherPaidEvent {
  voucherId: string;
  seId: string;
  paidBatchRef: string | null;
}

/**
 * Voucher-notification seam (Issue 38). The notification spine (Issue 03 — push/SMS/WhatsApp) isn't
 * built yet, so VouchersService fires review + paid events through this port. Issue 03 swaps the
 * default for the real multi-channel notifier; the contract stays unchanged.
 */
export interface VoucherNotifier {
  reviewed(event: VoucherReviewedEvent): Promise<void> | void;
  paid(event: VoucherPaidEvent): Promise<void> | void;
}

export const VOUCHER_NOTIFIER = Symbol('VOUCHER_NOTIFIER');

/** Default port until the notification spine lands — logs the event so it's observable in dev. */
export class LoggingVoucherNotifier implements VoucherNotifier {
  private readonly logger = new Logger('VoucherNotifier');
  reviewed(event: VoucherReviewedEvent): void {
    this.logger.log(
      `Voucher ${event.action} → SE ${event.seId} notified — voucher=${event.voucherId}${event.notes ? ` notes="${event.notes}"` : ''}`,
    );
  }
  paid(event: VoucherPaidEvent): void {
    this.logger.log(
      `Voucher PAID → SE ${event.seId} notified — voucher=${event.voucherId} batch=${event.paidBatchRef ?? '—'}`,
    );
  }
}
