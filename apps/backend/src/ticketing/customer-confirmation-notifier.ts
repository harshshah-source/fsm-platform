import { Logger } from '@nestjs/common';

/** Emitted when a Non-Op marking needs the customer's confirmation via a one-time email link. */
export interface CustomerConfirmationRequest {
  markingId: string;
  deviceId: bigint;
  /** The one-time confirmation token embedded in the link the customer receives. */
  token: string;
  /** Absolute confirmation URL (token included) the customer clicks to confirm. */
  confirmUrl: string;
}

/**
 * Customer-confirmation notification seam (Issue 35 AC#6). The Non-Operational dual-confirmation
 * flow needs the customer leg, delivered in v1 as a one-time tokenised email link (no portal). The
 * notification spine (Issue 03 — email/SMS/WhatsApp) isn't built yet, so the service fires the link
 * through this port. Issue 03 swaps the default for the real mailer; the contract stays unchanged.
 */
export interface CustomerConfirmationNotifier {
  sendConfirmationLink(request: CustomerConfirmationRequest): Promise<void> | void;
}

export const CUSTOMER_CONFIRMATION_NOTIFIER = Symbol('CUSTOMER_CONFIRMATION_NOTIFIER');

/** Default port until the notification spine lands — logs the link so it's observable in dev. */
export class LoggingCustomerConfirmationNotifier implements CustomerConfirmationNotifier {
  private readonly logger = new Logger('CustomerConfirmationNotifier');
  sendConfirmationLink(request: CustomerConfirmationRequest): void {
    this.logger.log(
      `Non-Op customer confirmation link — device=${request.deviceId} marking=${request.markingId} url=${request.confirmUrl}`,
    );
  }
}
