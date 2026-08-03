import { Injectable } from '@nestjs/common';
import { utcDayStart } from '../common/utc-day';
import { PrismaService } from '../prisma/prisma.service';
import { liveScheduleFilter } from '../scheduling/schedule-status';
import { SeCoverageService } from '../shared-pool/se-coverage.service';
import { notDeferredOn } from '../ticketing/deferral';

/** The image's row glyph (V/P/W/✓) — naming vocabulary pinned under #169, semantics fixed by #172
 *  Decision 3. VERIFY/IN_WORK are unambiguous (ticket status / active soft state); PLAN vs VISIT_NOW
 *  splits assigned-but-not-started day-plan work from open shared-pool work. */
export type MeTicketWorkState = 'VISIT_NOW' | 'PLAN' | 'IN_WORK' | 'VERIFY';

export interface MeTicketRow {
  ticketId: string;
  assigned: boolean;
  workState: MeTicketWorkState;
  workType: string;
  status: string;
  plantId: string;
  plantName: string;
  companyName: string;
  companyTier: string;
  slaBucket: string | null;
  deviceId: string;
  vehicleId: string | null;
  activeSoftState: string | null;
  createdAt: Date;
  lastStateChangedAt: Date;
}

export interface MeTicketsView {
  items: MeTicketRow[];
  cursor: null;
}

function workStateFor(status: string, assigned: boolean, inWork: boolean): MeTicketWorkState {
  if (status === 'VERIFICATION_PENDING') return 'VERIFY';
  if (inWork) return 'IN_WORK';
  return assigned ? 'PLAN' : 'VISIT_NOW';
}

/**
 * #161 — the merged SE ticket-read surface (`GET /api/me/tickets`), per #172 Decision 3: one endpoint
 * replacing the day-plan (`DayPlanQueryService`, unchanged — still backs the ZM SE-detail view) /
 * shared-pool (`SharedPoolService`, unchanged — still its own contract) split for the SE's own read.
 * Coverage scoping is unchanged either way — "across all mapped plants" (#172) — reusing #162's shared
 * `SeCoverageService` predicate rather than a second copy.
 *
 * Day Plan previously returned bare `{ticketId, sortOrder}` with nothing to expand it — the mobile
 * app had no data source past login. This returns the full row directly, bounded to phone-friendly
 * list-card fields (see the row shape below); a fuller per-ticket detail read is #161's own item 1
 * and is not built here.
 */
@Injectable()
export class MeTicketsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coverage: SeCoverageService,
  ) {}

  async getMyTickets(seId: string, now: Date = new Date()): Promise<MeTicketsView> {
    const coveredPlantIds = await this.coverage.coveredPlantIds(seId);

    const schedule = await this.prisma.workSchedule.findFirst({
      where: { seId, ...liveScheduleFilter() },
      orderBy: { dispatchedAt: 'desc' },
    });

    const assignedTicketIds = new Set<string>();
    if (schedule) {
      const batches = await this.prisma.plantBatchAssignment.findMany({
        where: { scheduleId: schedule.scheduleId, status: { in: ['AUTO_ASSIGNED', 'OVERRIDDEN'] } },
        include: { tickets: { where: { removedAt: null }, select: { ticketId: true } } },
      });
      for (const b of batches) for (const t of b.tickets) assignedTicketIds.add(t.ticketId);
    }

    const tickets = await this.prisma.ticket.findMany({
      where: {
        OR: [
          { ticketId: { in: [...assignedTicketIds] } },
          {
            plantId: { in: coveredPlantIds },
            status: 'OPEN',
            assignmentState: 'UNASSIGNED',
            ...notDeferredOn(utcDayStart(now)),
          },
        ],
      },
      orderBy: [{ plantId: 'asc' }, { createdAt: 'asc' }],
      include: {
        plant: { select: { name: true } },
        company: { select: { name: true } },
        device: { select: { state: { select: { slaBucket: true } } } },
      },
    });

    const activeSoftStates = await this.prisma.softState.findMany({
      where: { seId, resolvedAt: null, ticketId: { in: tickets.map((t) => t.ticketId) } },
      select: { ticketId: true, type: true },
    });
    const activeByTicket = new Map(activeSoftStates.map((s) => [s.ticketId, s.type]));

    const items: MeTicketRow[] = tickets.map((t) => {
      const assigned = assignedTicketIds.has(t.ticketId);
      const activeSoftState = activeByTicket.get(t.ticketId) ?? null;
      const inWork = activeSoftState === 'ON_SITE' || activeSoftState === 'TROUBLESHOOT_STARTED';
      return {
        ticketId: t.ticketId,
        assigned,
        workState: workStateFor(t.status, assigned, inWork),
        workType: t.workType,
        status: t.status,
        plantId: String(t.plantId),
        plantName: t.plant.name,
        companyName: t.company.name,
        companyTier: t.companyTier,
        slaBucket: t.device.state?.slaBucket ?? null,
        deviceId: String(t.deviceId),
        vehicleId: t.vehicleId != null ? String(t.vehicleId) : null,
        activeSoftState,
        createdAt: t.createdAt,
        lastStateChangedAt: t.lastStateChangedAt,
      };
    });

    return { items, cursor: null };
  }
}
