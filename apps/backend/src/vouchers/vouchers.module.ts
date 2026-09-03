import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MeVouchersService } from './me-vouchers.service';
import { NotificationVoucherNotifier } from './notification-voucher-notifier';
import { VOUCHER_NOTIFIER } from './voucher-notifier';
import { VouchersService } from './vouchers.service';

/**
 * Expense Vouchers (Issue 38, schema D15, CONTEXT §Expense Vouchers) — the SE reimbursement lifecycle:
 * SE offline-drafted submit, ZM review (own zone), SE resubmit, and the Operations-Head Finance export
 * + Mark PAID. `VouchersController`/`MeVouchersController` are registered in AppModule;
 * `MeVouchersService` (#163 item 1) is the SE-readable own-vouchers read.
 *
 * **#361 — `VOUCHER_NOTIFIER` now binds {@link NotificationVoucherNotifier}.** It bound
 * `LoggingVoucherNotifier` from Issue 38 until this slice, which meant the Voucher Review page's
 * "the SE is notified" was false: the SE was told nothing, in any channel, about an approval, a
 * rejection or a payment. The swap the old docstring anticipated ("Issue 03 swaps the default") simply
 * never happened, and nothing failed when it didn't — which is why it survived this long.
 */
@Module({
  // #361 — NotificationsModule for `NotificationService`: the review/paid notices are enqueued in the
  // decision's own `withAudit` transaction and delivered off the committed row.
  imports: [PrismaModule, AuditModule, NotificationsModule],
  providers: [
    VouchersService,
    MeVouchersService,
    { provide: VOUCHER_NOTIFIER, useClass: NotificationVoucherNotifier },
  ],
  exports: [VouchersService, MeVouchersService],
})
export class VouchersModule {}
