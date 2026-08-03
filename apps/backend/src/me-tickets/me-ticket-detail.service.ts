import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SeCoverageService } from '../shared-pool/se-coverage.service';
import { isTicketReadableBySe } from './se-ticket-access';
import { buildTechnicalHealth, type TechnicalHealth } from './technical-hints';
import { formatTicketNo, ticketNoAsNumber } from '../ticketing/ticket-no';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One entry in a ticket's Failure-Cycle chain (`FailureCycle.previousFailureCycleId`, walked oldest
 *  toward the ticket's own cycle). Bounded to `MAX_HISTORY_DEPTH` entries — this is the "repeat
 *  failure history" the mobile Ticket Detail screen wants, not the manager Device Detail's full
 *  lifetime list (`device-detail.service.ts`), which is deliberately not phone-payload-bounded. */
export interface FailureCycleHistoryEntry {
  cycleId: string;
  openedAt: string;
  closedAt: string | null;
  repeatFailure: boolean;
}

/**
 * One `ComponentRequest` raised against the ticket. This is the ticket's actual component-request
 * history (what an SE requested and its approve/ship/receive progress) — reusing `ComponentRequest`
 * as-is, no new business logic. It is NOT a catalog-driven "expected components for this device"
 * list: that derivation doesn't exist yet (`hard-filters.ts`'s `expectedComponentsAvailable` is
 * still hardcoded `true`, and no `expected_components` table exists — Issue 21/22, out of scope
 * here). For a ticket with no component requests this is simply `[]`.
 */
export interface ComponentRequestEntry {
  requestId: string;
  componentId: string | null;
  componentName: string | null;
  status: string;
  requestedAt: string;
}

/**
 * The mobile M3 Ticket Detail read (#161 item 1). See the field-by-field contract in the issue's
 * 2026-08-03 comment; the summary here is the shape only.
 *
 * `companyTier` is stamped on the ticket at creation time (`Ticket.companyTier`) and can diverge
 * from #157's zone-scoped *effective* tier override applied after creation — **by decided design**
 * (Q-B), not a bug. A frozen mobile client renders whatever this field says; do not "fix" the
 * apparent mismatch by joining the live override here.
 *
 * `transporterName` only — transporter phone/number is a column that does not exist yet (#171's
 * gap); this payload leaves contact incomplete rather than inventing a field.
 *
 * `readinessHint` mirrors `recommender.service.ts`'s own `vehicleReadiness: 'UNKNOWN'` hardcode
 * (`hard-filters.ts`'s `VehicleReadiness` union) — there is no per-ticket vehicle-readiness value
 * persisted anywhere to read (the Recommender computes it in-memory per dispatch run and never
 * stores it). Surfacing the field (always `'UNKNOWN'` today) is in scope; fixing the hardcode is a
 * separate systemic gap #161 explicitly defers.
 */
export interface MeTicketDetailView {
  ticketId: string;
  ticketNo: number;
  ticketNoDisplay: string;
  deviceId: string;
  vehicleNo: string | null;
  plantName: string;
  companyName: string;
  companyTier: string;
  transporterName: string | null;
  slaBucket: string | null;
  workType: string;
  status: string;
  activeSoftState: string | null;
  createdAt: string;
  lastStateChangedAt: string;
  failureCycleHistory: FailureCycleHistoryEntry[];
  expectedComponents: ComponentRequestEntry[];
  componentRequestStatus: string | null;
  waitingComponentSince: string | null;
  readinessHint: 'READY' | 'ON_TRIP' | 'STALE' | 'UNKNOWN';
  /** #84 — derived Technical Hints + raw telemetry, from the device's latest `RawDeviceSnapshot`.
   *  Purely advisory (see `technical-hints.ts`); `available:false` when the device has no snapshot
   *  row at all, distinct from an individual raw field being genuinely null. */
  technicalHealth: TechnicalHealth;
}

const MAX_FAILURE_HISTORY_DEPTH = 10;

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
        vehicle: { select: { vehicleNo: true, transporter: { select: { name: true } } } },
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
