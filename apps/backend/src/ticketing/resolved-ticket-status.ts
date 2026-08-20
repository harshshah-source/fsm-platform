import type { $Enums } from '../generated/prisma/client';

/**
 * The ticket statuses that mean the work on that ticket is over — successfully or not.
 *
 * **Why this file exists.** The same seven statuses were already written out three times, in three
 * modules, under two names: `RESOLVED_TICKET_STATUSES` in `schedule-closure-scheduler.service.ts`
 * (identical set), `CLOSED_TICKET_STATUSES` in `dashboard.service.ts` (identical set), and a
 * **four-member** `CLOSED_TICKET_STATUSES` in `entity-mapping-export.service.ts` that silently omits
 * `FAILED_VERIFICATION`, `FAILED_ACTIVATION` and `RECEIVED_AT_WAREHOUSE`. Whether that omission is a
 * deliberate export-scoping choice or a drift bug is not answerable from the code, which is precisely
 * the problem with a definition that lives in three places.
 *
 * #178 needed a fourth reader to agree with the closure paths, so this is the canonical set. The three
 * existing copies are **not** folded in here — that is a behaviour-affecting change to a live report
 * and an export, and it belongs to its own slice with its own tests, not to a bug fix that happens to
 * pass nearby. Fold them in deliberately; do not add a fifth copy.
 */
export const RESOLVED_TICKET_STATUSES = [
  'CLOSED',
  'CLOSED_AUTO_RECOVERY',
  'CLOSED_NON_OPERATIONAL',
  'FAILED_VERIFICATION',
  'FAILED_ACTIVATION',
  'FAILED_RECOVERY',
  'RECEIVED_AT_WAREHOUSE',
] as const satisfies readonly $Enums.TicketStatus[];
