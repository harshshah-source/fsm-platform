import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import type {
  MeTicketRow,
  MeTicketVehicleUnavailability,
  MeTicketWorkState,
  MeTicketsSection,
  MeTicketsView,
} from '@fsm/shared';
import { istDate, istDayStartInstant } from '../common/ist-day';
import { PrismaService } from '../prisma/prisma.service';
import { liveScheduleFilter } from '../scheduling/schedule-status';
import { SeCoverageService } from '../shared-pool/se-coverage.service';
import { notDeferredOn } from '../ticketing/deferral';
import { formatTicketNo, ticketNoAsNumber } from '../ticketing/ticket-no';
import { buildTechnicalHealth, pickTopHint, type TechnicalHint } from './technical-hints';

export type {
  MeTicketRow,
  MeTicketVehicleUnavailability,
  MeTicketWorkState,
  MeTicketsSection,
  MeTicketsView,
} from '@fsm/shared';

/**
 * #360 — a page, not the pool. The SE app polls this endpoint all day from a plant yard; before this
 * it re-sent every covered ticket every time (521 rows on the dev DB), which put the largest payload
 * in the system on the worst connection in it. 50 is one screen's worth several times over on the
 * mobile Tickets list (`docs/ui/mobile/tickets-priority-view.png`), so the common case is one page.
 */
export const ME_TICKETS_DEFAULT_TAKE = 50;

/**
 * The ceiling a caller can ask for. Present so that "give me everything" stops being expressible from
 * the client side — the defect this slice closes could otherwise be re-created by one `?take=100000`.
 */
export const ME_TICKETS_MAX_TAKE = 200;

/** The `?section=` vocabulary, one member per filter chip on the mobile Tickets screen. */
const SECTIONS: ReadonlySet<string> = new Set<MeTicketsSection>([
  'ALL',
  'VISIT_NOW',
  'PLAN',
  'IN_WORK',
  'VERIFY',
  'VEHICLE_UNAVAILABLE',
]);

/** The soft states that mean "the SE has this ticket open in front of them right now". */
const IN_WORK_SOFT_STATES: ReadonlySet<string> = new Set(['ON_SITE', 'TROUBLESHOOT_STARTED']);

export interface MeTicketsQuery {
  /** Rows per page. Junk / out-of-range values fall back to {@link ME_TICKETS_DEFAULT_TAKE} or clamp
   *  to {@link ME_TICKETS_MAX_TAKE} rather than 400-ing a screen that is otherwise fine. */
  take?: number;
  /** The opaque cursor from a previous page's `cursor`. */
  cursor?: string | null;
  /** One of {@link SECTIONS}; absent, `ALL` and anything unrecognised all mean "no filter". */
  section?: string | null;
}

/** The read's full sort key — what a cursor has to carry to resume exactly where a page stopped. */
interface TicketPageKey {
  plantId: bigint;
  createdAt: Date;
  ticketId: string;
}

/**
 * The page order, and the reason the cursor is a keyset rather than an offset.
 *
 * `plantId` first because the mobile list groups by plant stop; `createdAt` because oldest work is
 * the most urgent; `ticketId` last purely to make the order **total**. Without that last field two
 * tickets created in the same millisecond at the same plant have no defined order between pages, and
 * a keyset cursor would either skip one or repeat it — silently, and only under load.
 */
const PAGE_ORDER: Prisma.TicketOrderByWithRelationInput[] = [
  { plantId: 'asc' },
  { createdAt: 'asc' },
  { ticketId: 'asc' },
];

function encodeCursor(key: TicketPageKey): string {
  return Buffer.from(`${key.plantId}|${key.createdAt.toISOString()}|${key.ticketId}`, 'utf8').toString('base64url');
}

/**
 * Decode a cursor, or refuse the request.
 *
 * A 400 rather than "start from the beginning": a client that silently restarts its walk on a bad
 * cursor loops forever over page one, which on a polling mobile client is worse than the unpaginated
 * read this slice replaced. The cursor is opaque and only ever comes from a previous response, so a
 * malformed one is a bug on the caller's side and should say so.
 */
function decodeCursor(raw: string): TicketPageKey {
  try {
    const [plantId, createdAt, ticketId] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
    const at = new Date(createdAt ?? '');
    if (!plantId || !ticketId || Number.isNaN(at.getTime())) throw new Error('malformed cursor');
    return { plantId: BigInt(plantId), createdAt: at, ticketId };
  } catch {
    throw new BadRequestException({ code: 'INVALID_CURSOR' });
  }
}

/** "Strictly after this key in {@link PAGE_ORDER}" — the keyset predicate, spelled out rather than
 *  delegated to Prisma's `cursor`/`skip`, because the sort's leading fields are not unique and the
 *  row-comparison this needs has to be exactly the one the ordering uses. */
function afterKey(key: TicketPageKey): Prisma.TicketWhereInput {
  return {
    OR: [
      { plantId: { gt: key.plantId } },
      { plantId: key.plantId, createdAt: { gt: key.createdAt } },
      { plantId: key.plantId, createdAt: key.createdAt, ticketId: { gt: key.ticketId } },
    ],
  };
}

function sanitiseTake(take: number | undefined): number {
  if (take == null || !Number.isFinite(take)) return ME_TICKETS_DEFAULT_TAKE;
  const floored = Math.floor(take);
  if (floored < 1) return ME_TICKETS_DEFAULT_TAKE;
  return Math.min(floored, ME_TICKETS_MAX_TAKE);
}

function sanitiseSection(section: string | null | undefined): MeTicketsSection {
  const raw = String(section ?? '').trim().toUpperCase();
  return SECTIONS.has(raw) ? (raw as MeTicketsSection) : 'ALL';
}

function workStateFor(
  status: string,
  assigned: boolean,
  inWork: boolean,
  vehicleUnavailable: boolean,
): MeTicketWorkState {
  // #360 — first, because a ticket whose vehicle is away is not work in any of the other four senses:
  // the SE cannot start it, cannot verify it, and it is not on anybody's plan. Saying "Visit Now" over
  // an absence the engineer personally reported is precisely the confusion this slice removes.
  if (vehicleUnavailable) return 'VEHICLE_UNAVAILABLE';
  if (status === 'VERIFICATION_PENDING') return 'VERIFY';
  if (inWork) return 'IN_WORK';
  return assigned ? 'PLAN' : 'VISIT_NOW';
}

/** `{ ticketId: { in: [] } }` matches nothing, which is what we want — but `notIn: []` is a clause
 *  worth not emitting at all. Both are spelled here so the section predicates below stay readable. */
function idIn(ids: string[]): Prisma.TicketWhereInput {
  return { ticketId: { in: ids } };
}
function idNotIn(ids: string[]): Prisma.TicketWhereInput[] {
  return ids.length === 0 ? [] : [{ ticketId: { notIn: ids } }];
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
 *
 * #360 made the read a **page** and gave it a fifth work state. Both changes are about the same
 * thing: this is the contract a field engineer's phone polls all day on a patchy connection, so it
 * must be small, and it must never make work the engineer reported on simply disappear.
 */
@Injectable()
export class MeTicketsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coverage: SeCoverageService,
  ) {}

  async getMyTickets(seId: string, now: Date = new Date(), query: MeTicketsQuery = {}): Promise<MeTicketsView> {
    const take = sanitiseTake(query.take);
    const section = sanitiseSection(query.section);
    const after = query.cursor ? decodeCursor(query.cursor) : null;

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

    // #68 — RECOVERY (and INSTALL) dispatch sets `assignedSeId` directly with no
    // `PlantBatchAssignment` row, so the batch-derived set above never sees them. Materialised as its
    // own id set (#360) because `section` has to say "assigned" and "not assigned" as *database*
    // predicates, and `NOT (assigned_se_id = $1)` would quietly drop every row where the column is
    // NULL — which is almost all of them.
    //
    // Read only for the two sections that need it: this set is every ticket ever directly assigned to
    // this engineer, with no status bound (the visibility branch below has never had one either), so
    // it is the one query here that grows with the SE's career rather than with their day. The
    // default read — the one the phone actually polls — never issues it.
    const needsAssignedSet = section === 'PLAN' || section === 'VISIT_NOW';
    const directlyAssigned = needsAssignedSet
      ? await this.prisma.ticket.findMany({ where: { assignedSeId: seId }, select: { ticketId: true } })
      : [];
    const assignedIds = [...new Set([...assignedTicketIds, ...directlyAssigned.map((t) => t.ticketId)])];

    // PRD:510 — a ticket removed from the caller's own batch earlier TODAY (any override action)
    // stays on the read with `removedFromPlanAt` set, rather than silently disappearing (a same-day
    // defer to a future date would otherwise drop out of both branches below entirely). Scoped to the
    // schedule's own batches, not batch status, since REMOVE_TICKET/DEFER_TICKET already flip the
    // batch to OVERRIDDEN. Bounded to today so this never resurrects a stale removal from a prior day
    // once the plan has moved on — matching "for one session".
    const removedTodayByTicket = new Map<string, { removedAt: Date; deferredToDate: Date | null }>();
    if (schedule) {
      const removedRows = await this.prisma.batchAssignmentTicket.findMany({
        // `removed_at` is a Timestamptz, not a Date — so this needs the real instant IST midnight
        // occurred, NOT the UTC-midnight DATE form. Using the DATE form here would shift the
        // "removed today" window by 5h30m, which is what the retired `utcDayStart` did (#204).
        where: { batch: { scheduleId: schedule.scheduleId }, removedAt: { gte: istDayStartInstant(now) } },
        select: { ticketId: true, removedAt: true, deferredToDate: true },
      });
      for (const r of removedRows) removedTodayByTicket.set(r.ticketId, { removedAt: r.removedAt!, deferredToDate: r.deferredToDate });
    }

    // #360 AC2 — the caller's own OPEN vehicle-unavailability reports. Filing one defers the ticket
    // (`vehicle-unavailability.service.ts`), and `notDeferredOn` in the pool branch below then dropped
    // it from the SE's list the instant they filed it: the engineer who personally reported the
    // absence watched the ticket vanish, concluded the platform had lost it, and rang the dispatcher.
    // Scoped to `seId` because this is a compensation for *the caller's own* report — another SE's
    // report is not something this SE reported on, and resurrecting a deferred ticket for everyone
    // would undo the deferral itself.
    const vuReports = await this.prisma.vehicleUnavailabilityReport.findMany({
      where: { seId, status: 'OPEN' },
      orderBy: { id: 'desc' },
      select: { id: true, ticketId: true, status: true, reasonCode: true, expectedFrom: true, expectedTo: true },
    });
    const vuByTicket = new Map<string, MeTicketVehicleUnavailability>();
    for (const r of vuReports) {
      // `orderBy id desc` + first-wins: a ticket re-reported on carries the newest report, matching
      // #245's "last valid report wins" (the older one is SUPERSEDED, but a race can leave two OPEN).
      if (vuByTicket.has(r.ticketId)) continue;
      vuByTicket.set(r.ticketId, {
        reportId: String(r.id),
        status: r.status,
        expectedFrom: istDate(r.expectedFrom).toISOString().slice(0, 10),
        expectedTo: r.expectedTo ? istDate(r.expectedTo).toISOString().slice(0, 10) : null,
        reasonCode: r.reasonCode,
      });
    }
    const vuIds = [...vuByTicket.keys()];

    // The caller's live soft states, read before the page rather than after it (#360): `section` has
    // to express IN_WORK as a database predicate, and an SE holds a handful of these at a time.
    const activeSoftStates = await this.prisma.softState.findMany({
      where: { seId, resolvedAt: null },
      select: { ticketId: true, type: true },
    });
    const activeByTicket = new Map(activeSoftStates.map((s) => [s.ticketId, s.type]));
    const inWorkIds = activeSoftStates.filter((s) => IN_WORK_SOFT_STATES.has(s.type)).map((s) => s.ticketId);

    const visibility: Prisma.TicketWhereInput = {
      OR: [
        idIn([...assignedTicketIds]),
        {
          plantId: { in: coveredPlantIds },
          status: 'OPEN',
          assignmentState: 'UNASSIGNED',
          ...notDeferredOn(istDate(now)),
        },
        idIn([...removedTodayByTicket.keys()]),
        { assignedSeId: seId },
        idIn(vuIds), // #360 AC2
      ],
    };

    const sectionFilter = this.sectionFilter(section, { assignedIds, inWorkIds, vuIds });
    const matching: Prisma.TicketWhereInput = { AND: [visibility, ...(sectionFilter ? [sectionFilter] : [])] };

    // Two reads, not one: `total` is what the screen's "N open tickets" header shows, and deriving it
    // from the page would make it lie on every page but the last.
    const total = await this.prisma.ticket.count({ where: matching });

    const page = await this.prisma.ticket.findMany({
      where: after ? { AND: [matching, afterKey(after)] } : matching,
      orderBy: PAGE_ORDER,
      // One more than asked for: its presence is what distinguishes "this is the last page" from
      // "there is more", without a second count against the cursor.
      take: take + 1,
      include: {
        plant: { select: { name: true } },
        company: { select: { name: true } },
        device: { select: { state: { select: { slaBucket: true } } } },
        vehicle: { select: { vehicleNo: true } },
      },
    });
    const hasMore = page.length > take;
    const tickets = hasMore ? page.slice(0, take) : page;

    const topHintByDevice = await this.topHintsByDevice(tickets.map((t) => String(t.deviceId)));

    const items: MeTicketRow[] = tickets.map((t) => {
      const assigned = assignedTicketIds.has(t.ticketId) || t.assignedSeId === seId;
      const activeSoftState = activeByTicket.get(t.ticketId) ?? null;
      const inWork = activeSoftState === 'ON_SITE' || activeSoftState === 'TROUBLESHOOT_STARTED';
      const removedToday = removedTodayByTicket.get(t.ticketId) ?? null;
      const vehicleUnavailability = vuByTicket.get(t.ticketId) ?? null;
      return {
        ticketId: t.ticketId,
        ticketNo: ticketNoAsNumber(t.ticketNo),
        ticketNoDisplay: formatTicketNo(t.ticketNo),
        assigned,
        workState: workStateFor(t.status, assigned, inWork, vehicleUnavailability != null),
        workType: t.workType,
        status: t.status,
        plantId: String(t.plantId),
        plantName: t.plant.name,
        companyName: t.company.name,
        companyTier: t.companyTier,
        slaBucket: t.device.state?.slaBucket ?? null,
        deviceId: String(t.deviceId),
        vehicleId: t.vehicleId != null ? String(t.vehicleId) : null,
        vehicleNo: t.vehicle?.vehicleNo ?? null,
        activeSoftState,
        createdAt: t.createdAt,
        lastStateChangedAt: t.lastStateChangedAt,
        removedFromPlanAt: removedToday ? removedToday.removedAt.toISOString() : null,
        deferredToDate: removedToday?.deferredToDate ? removedToday.deferredToDate.toISOString().slice(0, 10) : null,
        topHint: topHintByDevice.get(String(t.deviceId)) ?? null,
        vehicleUnavailability,
      };
    });

    const last = tickets[tickets.length - 1];
    return {
      items,
      cursor: hasMore && last ? encodeCursor(last) : null,
      total,
    };
  }

  /**
   * `section` as a **database** predicate, so a filtered read pages over the filtered set rather than
   * over the whole one (#360).
   *
   * The obvious implementation — fetch the page, derive `workState`, drop the rows that do not match
   * — would page over the unfiltered set and hand back short, arbitrarily-sized pages: ask for 50
   * "Verify" rows and get 3, with no way to tell that from "there are only 3". Every distinction
   * `workStateFor` makes is already available as an id set here, so the filter and the derived state
   * are two spellings of one rule, and the `VERIFICATION_PENDING` / in-work / assigned precedence is
   * kept identical in both. `ALL` returns `null` — no clause at all, rather than a tautology.
   */
  private sectionFilter(
    section: MeTicketsSection,
    sets: { assignedIds: string[]; inWorkIds: string[]; vuIds: string[] },
  ): Prisma.TicketWhereInput | null {
    const { assignedIds, inWorkIds, vuIds } = sets;
    const notVu = idNotIn(vuIds);
    const notVerify: Prisma.TicketWhereInput = { status: { not: 'VERIFICATION_PENDING' } };
    switch (section) {
      case 'VEHICLE_UNAVAILABLE':
        return idIn(vuIds);
      case 'VERIFY':
        return { AND: [...notVu, { status: 'VERIFICATION_PENDING' }] };
      case 'IN_WORK':
        return { AND: [...notVu, idIn(inWorkIds), notVerify] };
      case 'PLAN':
        return { AND: [...notVu, ...idNotIn(inWorkIds), idIn(assignedIds), notVerify] };
      case 'VISIT_NOW':
        return { AND: [...notVu, ...idNotIn(inWorkIds), ...idNotIn(assignedIds), notVerify] };
      default:
        return null;
    }
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
