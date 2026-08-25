import type { PrismaService } from '../prisma/prisma.service';
import { liveScheduleFilter } from '../scheduling/schedule-status';

/** The engineer a ticket is live on right now, as a queue row needs to name them. */
export interface CurrentAssignee {
  seId: string;
  seName: string | null;
}

/**
 * Who currently holds these tickets, if anybody — the missing half of an escalation row.
 *
 * An `ESCALATION_REQUIRED` row means "a manager has to decide about this ticket". It has always been
 * read as "…and the Assign button in the queue is how", which was true while every escalation came
 * from the one path that raises them for **unassigned** work (#268's "no capacity-eligible SE"). It is
 * not true for #288's: an engineer going unavailable strands work that is still formally theirs, and
 * `assignTicket` refuses an assigned ticket rather than silently stealing it — so Assign would fail on
 * exactly the rows it looks most needed on.
 *
 * The resolution is a **reassign on that engineer's day plan**, which is a surface that already exists
 * (and, since #289, previews its impact). This tells a surface which case it is looking at, so it can
 * offer the door that works instead of the one that 409s. It is a read-time derivation, not a stored
 * column: who holds a ticket changes with every override, and a stamped copy would go stale silently.
 *
 * @returns ticket_id → the live assignee. Tickets on nobody's live plan are **absent**, not null.
 */
export async function currentAssigneesFor(
  prisma: Pick<PrismaService, 'batchAssignmentTicket'>,
  ticketIds: string[],
): Promise<Map<string, CurrentAssignee>> {
  if (ticketIds.length === 0) return new Map();
  const rows = await prisma.batchAssignmentTicket.findMany({
    where: {
      ticketId: { in: ticketIds },
      removedAt: null,
      batch: { schedule: liveScheduleFilter() },
    },
    select: {
      ticketId: true,
      batch: { select: { seId: true, engineer: { select: { user: { select: { name: true } } } } } },
    },
    orderBy: { id: 'desc' },
  });
  const out = new Map<string, CurrentAssignee>();
  // Newest row first, and the partial unique keeps at most one live row per ticket anyway; `if` rather
  // than overwrite so the invariant failing somewhere does not silently change which answer is given.
  for (const r of rows) {
    if (!out.has(r.ticketId)) out.set(r.ticketId, { seId: r.batch.seId, seName: r.batch.engineer?.user?.name ?? null });
  }
  return out;
}
