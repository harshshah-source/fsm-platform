import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MeVouchersService } from './me-vouchers.service';
import { LoggingVoucherNotifier, VOUCHER_NOTIFIER } from './voucher-notifier';
import { VouchersService } from './vouchers.service';

/**
 * Expense Vouchers (Issue 38, schema D15, CONTEXT §Expense Vouchers) — the SE reimbursement lifecycle:
 * SE offline-drafted submit, ZM review (own zone), SE resubmit, and the Operations-Head Finance export
 * + Mark PAID. The notification spine (Issue 03) swaps {@link LoggingVoucherNotifier} for the real
 * multi-channel notifier via {@link VOUCHER_NOTIFIER}. `VouchersController`/`MeVouchersController` are
 * registered in AppModule; `MeVouchersService` (#163 item 1) is the SE-readable own-vouchers read.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  providers: [VouchersService, MeVouchersService, { provide: VOUCHER_NOTIFIER, useClass: LoggingVoucherNotifier }],
  exports: [VouchersService, MeVouchersService],
})
export class VouchersModule {}
