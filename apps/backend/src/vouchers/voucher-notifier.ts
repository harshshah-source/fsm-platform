import type { NotifyInput } from '../notifications/notification.service';

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
 * Voucher-notification seam (Issue 38), **re-pointed by #361**.
 *
 * Originally this port *delivered*: the spine did not exist, so `VouchersService` fired review + paid
 * events at it post-commit and the bound implementation logged them. Both halves of that are now
 * wrong. The spine exists (Issue 03 / #337), and a post-commit fire is exactly the shape #338 removed
 * from twelve other sites — a crash between the commit and the call loses the notice with no trace,
 * and a throw in the call can damage an outcome that has already committed.
 *
 * So the port now returns the notice instead of sending it. It keeps the half that is genuinely
 * policy — **who is told, and what the notice says** — and the producer enqueues that as a durable
 * `NOTIFY` row inside the transaction that records the decision. Delivery, retry and the channel chain
 * belong to the outbox and `NotificationService`, which already do this for every other producer.
 *
 * Synchronous by design: it is called from inside a transaction, and a port that could await something
 * unrelated in there is a port that can hold a write lock open on somebody else's dependency.
 */
export interface VoucherNotifier {
  /** The notice a review decision owes the SE. */
  reviewed(event: VoucherReviewedEvent): NotifyInput;
  /** The notice a Mark-PAID owes the SE. */
  paid(event: VoucherPaidEvent): NotifyInput;
}

export const VOUCHER_NOTIFIER = Symbol('VOUCHER_NOTIFIER');
