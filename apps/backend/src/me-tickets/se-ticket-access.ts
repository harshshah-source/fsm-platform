import { istDate } from '../common/ist-day';
import { PrismaService } from '../prisma/prisma.service';
import { liveScheduleFilter } from '../scheduling/schedule-status';
import { SeCoverageService } from '../shared-pool/se-coverage.service';

/** The subset of `Ticket` columns {@link isTicketReadableBySe} needs — callers select only these. */
export interface TicketAccessFields {
  ticketId: string;
  assignedSeId: string | null;
  plantId: bigint;
  status: string;
  assignmentState: string;
  deferredUntil: Date | null;
}

/**
 * The #161 item 1 scope rule, factored out so item 3 (own-forms read) can reuse it rather than grow
 * a second copy — a ticket is SE-readable if EITHER (a) it is assigned to the caller directly
 * (`Ticket.assignedSeId`, the column RECOVERY/INSTALL dispatch writes) OR the caller's live
 * `WorkSchedule` → `PlantBatchAssignment` → `BatchAssignmentTicket` names it (the TROUBLESHOOT
 * day-plan path), OR (b) it is shared-pool-visible: `OPEN` + `UNASSIGNED` + not currently deferred,
 * at a plant the caller covers.
 */
export async function isTicketReadableBySe(
  prisma: PrismaService,
  coverage: SeCoverageService,
  ticket: TicketAccessFields,
  seId: string,
  now: Date,
): Promise<boolean> {
  if (ticket.assignedSeId === seId) return true;
  if (await assignedViaSchedule(prisma, ticket.ticketId, seId)) return true;

  const notDeferred = ticket.deferredUntil === null || ticket.deferredUntil <= istDate(now);
  if (ticket.status !== 'OPEN' || ticket.assignmentState !== 'UNASSIGNED' || !notDeferred) return false;
  return coverage.isPlantCovered(seId, ticket.plantId);
}

/** The TROUBLESHOOT day-plan assignment path — same mechanism `MeTicketsQueryService` resolves
 *  "assigned" with, narrowed to a single ticket rather than fetching the caller's whole batch set. */
async function assignedViaSchedule(prisma: PrismaService, ticketId: string, seId: string): Promise<boolean> {
  const schedule = await prisma.workSchedule.findFirst({
    where: { seId, ...liveScheduleFilter() },
    orderBy: { dispatchedAt: 'desc' },
  });
  if (!schedule) return false;

  const row = await prisma.batchAssignmentTicket.findFirst({
    where: {
      ticketId,
      removedAt: null,
      batch: { scheduleId: schedule.scheduleId, status: { in: ['AUTO_ASSIGNED', 'OVERRIDDEN'] } },
    },
    select: { id: true },
  });
  return row !== null;
}
