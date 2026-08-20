import type { PrismaService } from '../prisma/prisma.service';
import { REMOVAL_REASONS } from './removal-reason';

/** The narrow slice of the client this helper touches — a transaction client satisfies it too. */
type CloseAssignmentClient = Pick<PrismaService, 'batchAssignmentTicket' | 'ticket'>;

/**
 * Retire a resolved ticket's assignment — #178.
 *
 * **One writer, because six call sites cannot be kept in step by hand.** Every terminal closure path
 * (verification decision, manual auto-recovery, warehouse receipt, install close/fail, non-operational
 * marking) has to do exactly this, and the ones that already did it — #241's departure and
 * deactivation cancels — each grew their own inline copy. The #153 lesson applies: one predicate, one
 * writer. Call this inside the same transaction as the status flip, never after it, or a crash in the
 * window leaves precisely the inconsistency this exists to remove.
 *
 * **`removed_at IS NULL` is repeated in the write even though it is not redundant with anything the
 * caller knows.** `OverrideService` takes no advisory lock, so a ZM withdrawing the ticket can commit
 * between a caller's read and this write; keying only on `ticket_id` would overwrite their actor and
 * reason with a system stamp, and #244 reads that reason as a *predicate* — the mistake would be an
 * operational reclassification rather than a visible one. A row somebody else already closed is left
 * exactly as they left it. (Same reasoning, same shape, as `schedule-closure-scheduler.service.ts`.)
 *
 * **The actor is NULL by construction.** Somebody closed the *ticket*; nobody withdrew the
 * *assignment* — it ended as a consequence. Who closed the ticket is already recorded on the ticket's
 * own event and audit trail, which is where that question belongs. This mirrors the choice #241 made
 * for the cancellation paths.
 *
 * **Why `assignment_state` moves too.** The batch-row stamp is the load-bearing half — both
 * `committedDayLoad` and every day-plan read key on `removed_at` — but leaving a closed ticket
 * `FORMALLY_ASSIGNED` keeps the column meaning two different things, and #178 AC-2 pins the invariant
 * `FORMALLY_ASSIGNED ⇒ the ticket is live`. The flip is scoped to tickets with no live row **left**,
 * so a ticket some concurrent path has already re-assigned is not dragged back to UNASSIGNED.
 */
export async function retireAssignmentOnClosure(
  tx: CloseAssignmentClient,
  ticketIds: string[],
  now: Date,
): Promise<number> {
  if (ticketIds.length === 0) return 0;

  const { count } = await tx.batchAssignmentTicket.updateMany({
    where: { ticketId: { in: ticketIds }, removedAt: null },
    data: { removedAt: now, removedBy: null, removalReason: REMOVAL_REASONS.TICKET_RESOLVED },
  });

  await tx.ticket.updateMany({
    where: { ticketId: { in: ticketIds }, batchTickets: { none: { removedAt: null } } },
    data: { assignmentState: 'UNASSIGNED' },
  });

  return count;
}
