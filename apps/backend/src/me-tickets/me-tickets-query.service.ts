import { Injectable } from '@nestjs/common';
import { utcDayStart } from '../common/utc-day';
import { PrismaService } from '../prisma/prisma.service';
import { liveScheduleFilter } from '../scheduling/schedule-status';
import { SeCoverageService } from '../shared-pool/se-coverage.service';
import { notDeferredOn } from '../ticketing/deferral';
import { formatTicketNo, ticketNoAsNumber } from '../ticketing/ticket-no';
import { buildTechnicalHealth, pickTopHint, type TechnicalHint } from './technical-hints';

/** The image's row glyph (V/P/W/✓) — naming vocabulary pinned under #169, semantics fixed by #172
 *  Decision 3. VERIFY/IN_WORK are unambiguous (ticket status / active soft state); PLAN vs VISIT_NOW
 *  splits assigned-but-not-started day-plan work from open shared-pool work. */
export type MeTicketWorkState = 'VISIT_NOW' | 'PLAN' | 'IN_WORK' | 'VERIFY';

export interface MeTicketRow {
  ticketId: string;
  /** #161 D-4 — the `TCK-#####` display label's raw number (see `ticket-no.ts`). */
  ticketNo: number;
  /** Pre-formatted `TCK-#####` (zero-padded to 5) so the client never re-derives the padding rule. */
  ticketNoDisplay: string;
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
  /** PRD:510 — "removed Ticket shows 'removed' label for one session". Non-null (ISO timestamp) only
   *  when this ticket was removed from the caller's *current* day-plan batch earlier **today**
   *  (`BatchAssignmentTicket.removedAt`, any override action — REMOVE_TICKET/DEFER_TICKET/REASSIGN/
   *  SPLIT_BATCH — scoped to the caller's live `WorkSchedule`). Without this the row would either
   *  silently vanish (a same-day defer to a future date drops out of both the assigned and pool
   *  branches) or reappear with no signal that anything changed (a plain removal that returns to the
   *  pool). The client renders the label and may forget it locally after showing it once — there is
   *  no server-side "already shown this session" state to key on. `null` for a normal row. */
  removedFromPlanAt: string | null;
  /** Set alongside `removedFromPlanAt` only for a DEFER_TICKET removal — the date the ticket returns
   *  to the pool. `null` for every other case, including a non-removed row. */
  deferredToDate: string | null;
  /** #84 AC #2 — "card source = the single highest-severity hint" from the device's latest
   *  `RawDeviceSnapshot`, via the same pure derivation (`technical-hints.ts`) the full detail read
   *  (`MeTicketDetailView.technicalHealth.hints`) uses. `null` when no hint currently fires OR the
   *  device has no snapshot row at all — the list row has no separate "unavailable" signal, unlike
   *  the detail payload's `technicalHealth.available`; a client wanting to distinguish those two
   *  cases reads the detail payload. Also satisfies the `topTechnicalHint` field #161's own
   *  day-plan-expansion comment names separately — see this issue's landed-comment note so a future
   *  #161 continuation does not duplicate it. */
  topHint: TechnicalHint | null;
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

    // PRD:510 — a ticket removed from the caller's own batch earlier TODAY (any override action)
    // stays on the read with `removedFromPlanAt` set, rather than silently disappearing (a same-day
    // defer to a future date would otherwise drop out of both branches below entirely). Scoped to the
    // schedule's own batches, not batch status, since REMOVE_TICKET/DEFER_TICKET already flip the
    // batch to OVERRIDDEN. Bounded to today so this never resurrects a stale removal from a prior day
    // once the plan has moved on — matching "for one session".
    const removedTodayByTicket = new Map<string, { removedAt: Date; deferredToDate: Date | null }>();
    if (schedule) {
      const removedRows = await this.prisma.batchAssignmentTicket.findMany({
        where: { batch: { scheduleId: schedule.scheduleId }, removedAt: { gte: utcDayStart(now) } },
        select: { ticketId: true, removedAt: true, deferredToDate: true },
      });
      for (const r of removedRows) removedTodayByTicket.set(r.ticketId, { removedAt: r.removedAt!, deferredToDate: r.deferredToDate });
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
          { ticketId: { in: [...removedTodayByTicket.keys()] } },
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

    const topHintByDevice = await this.topHintsByDevice(tickets.map((t) => String(t.deviceId)));

    const items: MeTicketRow[] = tickets.map((t) => {
      const assigned = assignedTicketIds.has(t.ticketId);
      const activeSoftState = activeByTicket.get(t.ticketId) ?? null;
      const inWork = activeSoftState === 'ON_SITE' || activeSoftState === 'TROUBLESHOOT_STARTED';
      const removedToday = removedTodayByTicket.get(t.ticketId) ?? null;
      return {
        ticketId: t.ticketId,
        ticketNo: ticketNoAsNumber(t.ticketNo),
        ticketNoDisplay: formatTicketNo(t.ticketNo),
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
        removedFromPlanAt: removedToday ? removedToday.removedAt.toISOString() : null,
        deferredToDate: removedToday?.deferredToDate ? removedToday.deferredToDate.toISOString().slice(0, 10) : null,
        topHint: topHintByDevice.get(String(t.deviceId)) ?? null,
      };
    });

    return { items, cursor: null };
  }

  /** #84 — one highest-severity hint per distinct device on this page of tickets, via the same pure
   *  derivation `MeTicketDetailService` uses for the full detail read. Deduplicated by `deviceId`
   *  (not by ticket) since two tickets can share a device; read-only, same `[deviceId, gpsDatetime
   *  desc]` index as the detail read's `findFirst`. */
  private async topHintsByDevice(deviceIds: string[]): Promise<Map<string, TechnicalHint | null>> {
    const uniqueIds = [...new Set(deviceIds)];
    const entries = await Promise.all(
      uniqueIds.map(async (deviceId): Promise<[string, TechnicalHint | null]> => {
        const snapshot = await this.prisma.rawDeviceSnapshot.findFirst({
          where: { deviceId },
          orderBy: { gpsDatetime: 'desc' },
          select: {
            gpsDatetime: true, lat: true, lon: true, mainsStatus: true, mainsVoltage: true,
            gpsValidity: true, gpsMode: true, ignitionStatus: true, speed: true, creg: true, cgreg: true,
            csq: true, ipAddress: true, portNo: true, simSubscriberName: true, unitNo: true, deviceType: true,
          },
        });
        return [deviceId, pickTopHint(buildTechnicalHealth(snapshot).hints)];
      }),
    );
    return new Map(entries);
  }
}
