import { Injectable } from '@nestjs/common';
import type { NotifyInput } from '../notifications/notification.service';
import { PRD_NOTICE_TYPES } from '../notifications/prd-event-notice';
import type { VoucherNotifier, VoucherPaidEvent, VoucherReviewedEvent } from './voucher-notifier';

/**
 * #361 (VCH-07) — the voucher notifier that actually notifies.
 *
 * **What was wrong.** `vouchers.module.ts` bound `LoggingVoucherNotifier`, whose docstring said
 * "default port until the notification spine lands". The spine landed in Issue 03, the durable outbox
 * in #338 and the push exit in #337 — and the binding never moved. Meanwhile the Voucher Review page
 * told the reviewing manager, in as many words, that the SE would be notified. So a ZM rejected an
 * engineer's month of expenses believing the engineer had been told, and the engineer discovered it
 * whenever they next happened to open the app. That gap is worse than having no notice at all: a
 * promise in the UI is what stops anyone from chasing the thing it promises.
 *
 * **The port earns its keep by building the notice, not by delivering it.** This is the one design
 * decision in the voucher half worth recording. #338 established two row shapes and the rule for
 * choosing between them: a `NOTIFY` row carrying a *resolved* `NotifyInput` for producers that call
 * `NotificationService` directly, and an event row delivered through a port for `InstallNotifier` /
 * `RecoveryNotifier`, which resolve their own recipients and — in `escalatedToOh`'s case —
 * deliberately notify nobody. Vouchers do neither: there is exactly one recipient and it is written on
 * the voucher. Flattening to a `NOTIFY` row is therefore the correct shape, and it costs nothing that
 * a seam was protecting.
 *
 * So the port keeps the half that is real policy — *who is told and what the notice says* — and
 * returns it, synchronously, for the producer to enqueue **inside its own transaction**. Delivery
 * belongs to the outbox and to `NotificationService`. The practical consequence is that the retry
 * sweep already knows how to redeliver a voucher notice, because it is an ordinary `NOTIFY` row; the
 * alternative would have meant threading a fourth deliverer through `OutboxDeliverers` and the
 * seventeen-argument factory that builds the sweep — which is precisely the shape #338 found a live
 * bug in.
 */
@Injectable()
export class NotificationVoucherNotifier implements VoucherNotifier {
  reviewed(event: VoucherReviewedEvent): NotifyInput {
    return {
      recipients: [{ userId: event.seId, role: 'SERVICE_ENGINEER' }],
      type: PRD_NOTICE_TYPES.voucherReviewed,
      title: REVIEW_TITLES[event.action],
      // The notes are the decision. "Needs clarification" without them is a dead end, and a rejection
      // without them reads as arbitrary — which is how an expense process loses the field's trust.
      body: event.notes ? `${REVIEW_BODIES[event.action]} ${event.notes}` : REVIEW_BODIES[event.action],
      entityType: 'expense_voucher',
      entityId: event.voucherId,
      deliveryModel: 'GENERAL',
      metadata: { action: event.action, notes: event.notes },
    };
  }

  paid(event: VoucherPaidEvent): NotifyInput {
    return {
      recipients: [{ userId: event.seId, role: 'SERVICE_ENGINEER' }],
      type: PRD_NOTICE_TYPES.voucherPaid,
      title: 'Expense voucher paid',
      body: event.paidBatchRef
        ? `Your expense voucher has been paid in batch ${event.paidBatchRef}.`
        : 'Your expense voucher has been paid.',
      entityType: 'expense_voucher',
      entityId: event.voucherId,
      deliveryModel: 'GENERAL',
      metadata: { paidBatchRef: event.paidBatchRef },
    };
  }
}

const REVIEW_TITLES: Record<VoucherReviewedEvent['action'], string> = {
  APPROVE: 'Expense voucher approved',
  REJECT: 'Expense voucher rejected',
  NEEDS_CLARIFICATION: 'Expense voucher needs clarification',
};

const REVIEW_BODIES: Record<VoucherReviewedEvent['action'], string> = {
  APPROVE: 'Your zonal manager approved your expense voucher. It will be paid in the next Finance batch.',
  REJECT: 'Your zonal manager rejected your expense voucher.',
  NEEDS_CLARIFICATION: 'Your zonal manager needs more detail before approving your expense voucher. Resubmit it with the answer.',
};
