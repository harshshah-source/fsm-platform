import type { UnableToCollectReason } from '@fsm/shared';

/** e.g. `ON_SITE` -> "On Site", `RECEIVED_AT_WAREHOUSE` -> "Received At Warehouse". */
export function formatRecoveryStatusLabel(status: string): string {
  return status
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

/** e.g. `COMPANY_REFUSED` -> "Company Refused". */
export function formatUnableToCollectReasonLabel(reason: UnableToCollectReason): string {
  return reason
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}
