import type { ExpenseCategory, VoucherStatus } from '@fsm/shared';
import type { SemanticStatus } from '../theme/tokens';

/** e.g. `ACCOMMODATION` -> "Accommodation". */
export function formatCategoryLabel(category: ExpenseCategory): string {
  return category.charAt(0) + category.slice(1).toLowerCase();
}

/** PRD §494 My Vouchers statuses. "Pending"/"Manager Review" both surface as `ZONAL_MANAGER_REVIEW`
 *  server-side (`me-vouchers.service.ts`'s own `PENDING_STATUSES` comment) — shown here with the
 *  raw status label so nothing is collapsed the server didn't already collapse. */
const STATUS_LABEL: Record<VoucherStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  ZONAL_MANAGER_REVIEW: 'Manager Review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  NEEDS_CLARIFICATION: 'Needs Clarification',
  PAID: 'Paid',
};

const STATUS_SEMANTIC: Record<VoucherStatus, SemanticStatus> = {
  DRAFT: 'neutral',
  SUBMITTED: 'info',
  ZONAL_MANAGER_REVIEW: 'info',
  APPROVED: 'success',
  REJECTED: 'critical',
  NEEDS_CLARIFICATION: 'warning',
  PAID: 'verified',
};

export function voucherStatusLabel(status: VoucherStatus): string {
  return STATUS_LABEL[status];
}

export function voucherStatusSemantic(status: VoucherStatus): SemanticStatus {
  return STATUS_SEMANTIC[status];
}
