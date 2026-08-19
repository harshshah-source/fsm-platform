import { Injectable } from '@nestjs/common';
import type { ComponentRequestEntry, FailureCycleHistoryEntry, MeTicketDetailView, TechnicalHealth } from '@fsm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SeCoverageService } from '../shared-pool/se-coverage.service';
import { isTicketReadableBySe } from './se-ticket-access';
import { buildTechnicalHealth } from './technical-hints';
import { formatTicketNo, ticketNoAsNumber } from '../ticketing/ticket-no';

export type { ComponentRequestEntry, FailureCycleHistoryEntry, MeTicketDetailView } from '@fsm/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FAILURE_HISTORY_DEPTH = 10;

/**
 * The mobile M3 Ticket Detail read (#161 item 1). `MeTicketDetailView`/`FailureCycleHistoryEntry`/
 * `ComponentRequestEntry` now live in `@fsm/shared` (#57) — see their doc comments there for the
 * field-by-field contract (`companyTier` staleness-by-design, `transporterContact` resolved from
 * the #171 FSM-owned master column (nullable, honest "no contact on file" until populated),
 * `readinessHint` always `'UNKNOWN'` pending the Recommender persisting a real value).
 */

/**
 * #161 item 1 — `GET /api/me/tickets/:id`, the SE ticket-detail read. Covers TROUBLESHOOT, RECOVERY
 * and INSTALL uniformly (all three are `workType` rows on the same `Ticket` model) — this is what
 * closes the literal gap `RecoveryController` (POST-only) left, without adding a parallel GET there;
 * `install.controller.ts`'s own `GET /install/:ticketId` is untouched and keeps working for its
 * existing INSTALL_READER_ROLES callers (WM included), this is simply an additional read path.
 *
 * Scope (mirrors the issue's own scope rule, reusing #162's `SeCoverageService` — no second coverage
 * predicate): a ticket is SE-readable if EITHER (a) it is assigned to the caller — `Ticket.
 * assignedSeId === seId` (the column RECOVERY/INSTALL dispatch writes directly) OR the caller's live
 * `WorkSchedule` → `PlantBatchAssignment` → `BatchAssignmentTicket` names it (the TROUBLESHOOT
 * day-plan path, same mechanism `MeTicketsQueryService` already resolves "assigned" with) — OR (b)
 * it is shared-pool-visible: `OPEN` + `UNASSIGNED` + not currently deferred, at a plant the caller
 * covers. Outside both → `null`, which the controller turns into a 404 (never leaking existence to
 * an SE with no legitimate reason to know about the ticket).
 */
@Injectable()
export class MeTicketDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coverage: SeCoverageService,
  ) {}

  async getTicketDetail(seId: string, ticketId: string, now: Date = new Date()): Promise<MeTicketDetailView | null> {
    if (!UUID_RE.test(ticketId)) return null;

    const ticket = await this.prisma.ticket.findUnique({
      where: { ticketId },
      include: {
        plant: { select: { name: true } },
        company: { select: { name: true } },
        vehicle: { select: { vehicleNo: true, transporter: { select: { name: true, contactPhone: true } } } },
        device: { select: { state: { select: { slaBucket: true } } } },
        failureCycle: { select: { cycleId: true, state: true, slaPausedAt: true, previousFailureCycleId: true } },
      },
    });
    if (!ticket) return null;

    if (!(await isTicketReadableBySe(this.prisma, this.coverage, ticket, seId, now))) return null;

    const [activeSoftState, failureCycleHistory, componentRequests, technicalHealth] = await Promise.all([
      this.activeSoftState(ticketId, seId),
      this.failureCycleHistory(ticket.failureCycle?.cycleId ?? null),
      this.componentRequests(ticketId),
      this.technicalHealth(String(ticket.deviceId)),
    ]);

    const latestComponentRequest = componentRequests[componentRequests.length - 1] ?? null;
    const waitingComponentSince =
      ticket.failureCycle?.state === 'WAITING_COMPONENT' && ticket.failureCycle.slaPausedAt
        ? ticket.failureCycle.slaPausedAt.toISOString()
        : null;

    return {
      ticketId: ticket.ticketId,
      ticketNo: ticketNoAsNumber(ticket.ticketNo),
      ticketNoDisplay: formatTicketNo(ticket.ticketNo),
      deviceId: String(ticket.deviceId),
      vehicleNo: ticket.vehicle?.vehicleNo ?? null,
      plantName: ticket.plant.name,
      companyName: ticket.company.name,
      companyTier: ticket.companyTier,
      transporterName: ticket.vehicle?.transporter?.name ?? null,
      transporterContact: ticket.vehicle?.transporter?.contactPhone ?? null,
      slaBucket: ticket.device.state?.slaBucket ?? null,
      workType: ticket.workType,
      status: ticket.status,
      activeSoftState,
      createdAt: ticket.createdAt.toISOString(),
      lastStateChangedAt: ticket.lastStateChangedAt.toISOString(),
      failureCycleHistory,
      expectedComponents: componentRequests,
      componentRequestStatus: latestComponentRequest?.status ?? null,
      waitingComponentSince,
      // Not derived — see the class/interface doc. Kept as a literal so the field's absence-of-data
      // state is honest rather than implying a computation that does not exist.
      readinessHint: 'UNKNOWN',
      technicalHealth,
      // `@db.Date`, so this is UTC midnight of the IST day — rendered as-is, never shifted to local.
      deferredUntil: ticket.deferredUntil ? ticket.deferredUntil.toISOString() : null,
    };
  }

  /** #84 — the latest `RawDeviceSnapshot` for the ticket's device, mapped through the pure
   *  `buildTechnicalHealth` derivation. The existing `[deviceId, gpsDatetime desc]` index supports
   *  this `findFirst` directly (no new index needed). Read-only — this method and everything it
   *  calls only ever reads `raw_device_snapshots`. */
  private async technicalHealth(deviceId: string): Promise<TechnicalHealth> {
    const snapshot = await this.prisma.rawDeviceSnapshot.findFirst({
      where: { deviceId },
      orderBy: { gpsDatetime: 'desc' },
      select: {
        gpsDatetime: true, lat: true, lon: true, mainsStatus: true, mainsVoltage: true,
        gpsValidity: true, gpsMode: true, ignitionStatus: true, speed: true, creg: true, cgreg: true,
        csq: true, ipAddress: true, portNo: true, simSubscriberName: true, unitNo: true, deviceType: true,
      },
    });
    return buildTechnicalHealth(snapshot);
  }

  /** Sourced the same way `MeTicketsQueryService.getMyTickets` derives it (#161 item 2): the caller's
   *  own unresolved `SoftState` on this ticket. Soft State is inherently per-(SE, ticket) — an SE
   *  viewing a shared-pool ticket they have not engaged with correctly sees `null` here. */
  private async activeSoftState(ticketId: string, seId: string): Promise<string | null> {
    const row = await this.prisma.softState.findFirst({
      where: { ticketId, seId, resolvedAt: null },
      select: { type: true },
    });
    return row?.type ?? null;
  }

  /** Walks `FailureCycle.previousFailureCycleId` from the ticket's own (current) cycle backward,
   *  bounded to `MAX_FAILURE_HISTORY_DEPTH` entries. `null` for INSTALL/RECOVERY tickets, which carry
   *  no failure cycle. */
  private async failureCycleHistory(cycleId: string | null): Promise<FailureCycleHistoryEntry[]> {
    const history: FailureCycleHistoryEntry[] = [];
    let current = cycleId;
    for (let i = 0; i < MAX_FAILURE_HISTORY_DEPTH && current; i++) {
      const cycle = await this.prisma.failureCycle.findUnique({
        where: { cycleId: current },
        select: { cycleId: true, openedAt: true, closedAt: true, repeatFailure: true, previousFailureCycleId: true },
      });
      if (!cycle) break;
      history.push({
        cycleId: cycle.cycleId,
        openedAt: cycle.openedAt.toISOString(),
        closedAt: cycle.closedAt ? cycle.closedAt.toISOString() : null,
        repeatFailure: cycle.repeatFailure,
      });
      current = cycle.previousFailureCycleId;
    }
    return history;
  }

  private async componentRequests(ticketId: string): Promise<ComponentRequestEntry[]> {
    const rows = await this.prisma.componentRequest.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
      include: { component: { select: { name: true } } },
    });
    return rows.map((r) => ({
      requestId: r.requestId,
      componentId: r.componentId !== null ? String(r.componentId) : null,
      componentName: r.component?.name ?? null,
      status: r.status,
      requestedAt: r.createdAt.toISOString(),
    }));
  }
}
