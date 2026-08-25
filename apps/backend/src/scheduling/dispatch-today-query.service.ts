import { ForbiddenException, Injectable } from '@nestjs/common';
import { istDate } from '../common/ist-day';
import { PrismaService } from '../prisma/prisma.service';
import { isSystemAddSource } from './add-source';
import { committedDayPlan } from './committed-day-load';
import { liveScheduleFilter } from './schedule-status';
import type { ZmScope } from './zm-schedule-query.service';

/** A ticket as it sits on a stop — persisted order and persisted provenance, nothing derived. */
export interface TodayTicket {
  ticketId: string;
  sortOrder: number;
  slaBucket: string | null;
  companyTier: string | null;
  /** #283 — which door this came through. NULL is *unknown*, and must never render as system. */
  addSource: string | null;
  addedBy: string | null;
  addReason: string | null;
  coverageTypeAtAssign: string | null;
  /** True when the engine, not a person, placed it. Derived from `addSource` alone, never guessed. */
  systemPlaced: boolean;
  /** The vehicle is due back today (#248's `RET` chip). */
  returnDueToday: boolean;
}

/** One plant stop in the engineer's ordered day. */
export interface TodayStop {
  batchId: string;
  stopSequence: number;
  plantId: string;
  plantName: string;
  status: string;
  /** The run that created this batch, when one did. Null for manual and intraday-created batches. */
  runId: string | null;
  tickets: TodayTicket[];
}

/** One lane of the deck. Present even when the engineer has nothing today — an empty lane is a fact. */
export interface TodayEngineer {
  seId: string;
  name: string;
  coverageType: string;
  committed: number;
  dailyCapacity: number;
  overCapacity: boolean;
  /** `AVAILABLE`, or the availability status in force for the operating day (leave, off-shift…). */
  availability: string;
  scheduleId: string | null;
  scheduleStatus: string | null;
  stops: TodayStop[];
}

/** The header's counters. Every one is a count of something in this payload or beside it. */
export interface TodaySituation {
  placed: number;
  unassignable: number;
  held: number;
  criticalNeedsYou: number;
  overCapacity: number;
  changesToday: number;
}

export interface TodayRun {
  runId: string;
  status: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface TodayUnassignable {
  ticketId: string;
  deviceId: string | null;
  plantId: string | null;
  plantName: string | null;
  poolEmptyReason: string | null;
}

export interface TodayHold {
  ticketId: string;
  deviceId: string | null;
  plantName: string | null;
  heldUntil: string;
  /** From the ticket's OPEN vehicle-unavailability report, when one backs the hold. */
  expectedFrom: string | null;
  decidedBy: string | null;
}

export interface TodayEscalation {
  insertionId: string;
  ticketId: string;
  slaBucket: string | null;
  createdAt: string;
}

export interface DispatchTodayView {
  operatingDay: string;
  zone: { zoneId: string; name: string };
  run: TodayRun | null;
  engineers: TodayEngineer[];
  situation: TodaySituation;
  rails: {
    unassignable: TodayUnassignable[];
    held: TodayHold[];
    /**
     * Policy-withheld work is a **count**, and says so.
     *
     * The engine counts it (`recommender.service.ts:401`) and never itemises it — those tickets get
     * no recommendation, no UNASSIGNABLE row and no trace, so there is nothing to list. Publishing a
     * fabricated list here, or silently showing a count that looks like a truncated list, is exactly
     * what #282 R6 forbids. `itemised: false` is the honest contract, and #285 renders it as a count.
     */
    policyWithheld: { count: number; itemised: false };
  };
  escalations: TodayEscalation[];
}

/**
 * The Today's Dispatch cockpit's single read (#284, for the #282-approved Crew Deck).
 *
 * **This service decides nothing.** Every number is either persisted by the engine or produced by the
 * one shared function that already owns it — `committedDayPlan` for load (#269 / #272 R9, so the deck
 * cannot fork a second definition of "committed"), the persisted `stop_sequence` / `sort_order` for
 * ordering, `add_source` for provenance (#283). No eligibility, capacity or tier is recomputed for
 * display.
 *
 * **Scoped to the operating day, deliberately.** `ZmScheduleQueryService.listSchedules` filters on
 * live status alone with no date predicate, so it returns stale never-closed plans alongside today's
 * — while the nav row, the page copy and `DispatchTimelineNote` all say "today". The cockpit is the
 * surface that finally has to be right about that, so the predicate here is
 * `dateFrom <= day <= dateTo`, the same rule `DayPlanQueryService` already applies for the SE-facing
 * read.
 */
@Injectable()
export class DispatchTodayQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async today(scope: ZmScope, opts: { zoneId: bigint; now?: Date }): Promise<DispatchTodayView> {
    const now = opts.now ?? new Date();
    const day = istDate(now);
    const zoneId = opts.zoneId;

    // Server-side clamp, matching every other scheduler read: a ZM's reach is their own zone and the
    // controller's query parameter cannot widen it.
    if (scope.role === 'ZONAL_MANAGER' && scope.zoneId != null && BigInt(scope.zoneId) !== zoneId) {
      throw new ForbiddenException({ code: 'ZONE_SCOPE_VIOLATION' });
    }

    const zone = await this.prisma.zone.findUnique({ where: { zoneId }, select: { zoneId: true, name: true } });
    if (!zone) throw new ForbiddenException({ code: 'ZONE_NOT_FOUND' });

    const engineers = await this.prisma.engineerMaster.findMany({
      where: { isActive: true, zoneId },
      orderBy: { engineerId: 'asc' },
      include: { user: { select: { name: true } } },
    });
    const seIds = engineers.map((e) => e.engineerId);

    // The operating day's plans. `dateFrom <= day <= dateTo` is what makes this "today" — live status
    // alone is what makes `/schedules` wrong.
    const schedules = await this.prisma.workSchedule.findMany({
      where: {
        zoneId,
        seId: { in: seIds },
        dateFrom: { lte: day },
        dateTo: { gte: day },
        ...liveScheduleFilter(),
      },
      orderBy: { scheduleId: 'asc' },
      include: {
        batches: {
          where: { status: { in: ['AUTO_ASSIGNED', 'OVERRIDDEN'] } },
          orderBy: { stopSequence: 'asc' },
          include: {
            plant: { select: { name: true } },
            tickets: {
              where: { removedAt: null },
              orderBy: { sortOrder: 'asc' },
              include: { ticket: { select: { companyTier: true, deviceId: true } } },
            },
          },
        },
      },
    });

    const ticketIds = schedules.flatMap((s) => s.batches.flatMap((b) => b.tickets.map((t) => t.ticketId)));
    const [buckets, returnDue, load, availability] = await Promise.all([
      this.bucketByTicket(ticketIds),
      this.returnDueToday(ticketIds, day),
      // One batched query for the whole zone — the same function the engine enforces against.
      committedDayPlan(this.prisma, day, { seIds }),
      this.availabilityBySe(seIds, now),
    ]);

    const scheduleBySe = new Map(schedules.map((s) => [s.seId, s]));
    const lanes: TodayEngineer[] = engineers.map((e) => {
      const sched = scheduleBySe.get(e.engineerId);
      const committed = load.get(e.engineerId)?.count ?? 0;
      return {
        seId: e.engineerId,
        name: e.user?.name ?? e.engineerId,
        coverageType: e.coverageType,
        committed,
        dailyCapacity: e.dailyCapacity,
        // `>=`, matching the engine's own `OVER_CAPACITY` filter: an SE at exactly cap is one no
        // automatic path will add to, so showing them as having room would restate the disagreement
        // #269 closed.
        overCapacity: committed >= e.dailyCapacity,
        availability: availability.get(e.engineerId) ?? 'AVAILABLE',
        scheduleId: sched ? String(sched.scheduleId) : null,
        scheduleStatus: sched?.status ?? null,
        stops: (sched?.batches ?? [])
          // A batch whose tickets were all removed is not a stop the engineer will make.
          .filter((b) => b.tickets.length > 0)
          .map((b) => ({
            batchId: String(b.batchId),
            stopSequence: b.stopSequence,
            plantId: String(b.plantId),
            plantName: b.plant?.name ?? String(b.plantId),
            status: b.status,
            runId: b.runId != null ? String(b.runId) : null,
            tickets: b.tickets.map((t) => ({
              ticketId: t.ticketId,
              sortOrder: t.sortOrder,
              slaBucket: buckets.get(t.ticketId) ?? null,
              companyTier: t.ticket?.companyTier ?? null,
              addSource: t.addSource,
              addedBy: t.addedBy,
              addReason: t.addReason,
              coverageTypeAtAssign: t.coverageTypeAtAssign,
              systemPlaced: isSystemAddSource(t.addSource),
              returnDueToday: returnDue.has(t.ticketId),
            })),
          })),
      };
    });

    const [run, unassignable, held, escalations, changesToday, policyWithheld] = await Promise.all([
      this.latestRun(zoneId, day),
      this.unassignableToday(zoneId, day),
      this.heldToday(zoneId, day),
      this.escalationsOpen(zoneId),
      this.changesTodayCount(zoneId, day),
      this.policyWithheldCount(zoneId, day),
    ]);

    return {
      operatingDay: day.toISOString().slice(0, 10),
      zone: { zoneId: String(zone.zoneId), name: zone.name },
      run,
      engineers: lanes,
      situation: {
        placed: lanes.reduce((n, e) => n + e.stops.reduce((m, s) => m + s.tickets.length, 0), 0),
        unassignable: unassignable.length,
        held: held.length,
        criticalNeedsYou: escalations.length,
        overCapacity: lanes.filter((e) => e.overCapacity).length,
        changesToday,
      },
      rails: { unassignable, held, policyWithheld: { count: policyWithheld, itemised: false } },
      escalations,
    };
  }

  /** SLA bucket per ticket — read from device_state, the same source the engine ranks on. */
  private async bucketByTicket(ticketIds: string[]): Promise<Map<string, string | null>> {
    if (ticketIds.length === 0) return new Map();
    const rows = await this.prisma.ticket.findMany({
      where: { ticketId: { in: ticketIds } },
      select: { ticketId: true, deviceId: true },
    });
    const states = await this.prisma.deviceState.findMany({
      where: { deviceId: { in: rows.map((r) => r.deviceId).filter((d): d is string => d != null) } },
      select: { deviceId: true, slaBucket: true },
    });
    const byDevice = new Map(states.map((s) => [s.deviceId, s.slaBucket]));
    return new Map(rows.map((r) => [r.ticketId, (r.deviceId ? byDevice.get(r.deviceId) : null) ?? null]));
  }

  /**
   * Tickets whose vehicle is due back on or before today — the design's `RET` chip (#248).
   *
   * Restricted to **OPEN** reports: a resolved one describes a vehicle that already came back, and
   * chipping that ticket would tell the operator to expect an arrival that has happened. The bound is
   * `< end of the operating day`, so an overdue vehicle still carries the chip rather than silently
   * losing it the moment its date passes — overdue is exactly when the operator most needs to see it.
   */
  private async returnDueToday(ticketIds: string[], day: Date): Promise<Set<string>> {
    if (ticketIds.length === 0) return new Set();
    const rows = await this.prisma.vehicleUnavailabilityReport.findMany({
      where: {
        ticketId: { in: ticketIds },
        status: 'OPEN',
        expectedFrom: { lt: new Date(day.getTime() + 86_400_000) },
      },
      select: { ticketId: true },
    });
    return new Set(rows.map((r) => r.ticketId));
  }

  /** The availability status in force for the operating day, per SE. */
  private async availabilityBySe(seIds: string[], now: Date): Promise<Map<string, string>> {
    if (seIds.length === 0) return new Map();
    const rows = await this.prisma.seAvailability.findMany({
      where: { seId: { in: seIds }, windowStart: { lte: now }, OR: [{ windowEnd: null }, { windowEnd: { gte: now } }] },
      orderBy: { windowStart: 'desc' },
      select: { seId: true, status: true },
    });
    const out = new Map<string, string>();
    for (const r of rows) if (!out.has(r.seId)) out.set(r.seId, r.status);
    return out;
  }

  /** The run that produced (or is producing) this zone's operating day, if any. */
  private async latestRun(zoneId: bigint, day: Date): Promise<TodayRun | null> {
    const zoneRow = await this.prisma.dispatchRunZone.findFirst({
      where: { zoneId, run: { startedAt: { gte: day, lt: new Date(day.getTime() + 86_400_000) } } },
      orderBy: { runId: 'desc' },
      include: { run: true },
    });
    if (!zoneRow?.run) return null;
    return {
      runId: String(zoneRow.run.runId),
      status: zoneRow.run.status,
      trigger: zoneRow.run.trigger,
      startedAt: zoneRow.run.startedAt.toISOString(),
      finishedAt: zoneRow.run.finishedAt?.toISOString() ?? null,
    };
  }

  /** What the latest run could not place — persisted rows with their reasons, never a bare count. */
  private async unassignableToday(zoneId: bigint, day: Date): Promise<TodayUnassignable[]> {
    const traces = await this.prisma.dispatchDecisionTrace.findMany({
      where: { zoneId, seId: null, run: { startedAt: { gte: day, lt: new Date(day.getTime() + 86_400_000) } } },
      orderBy: { traceId: 'asc' },
      include: { ticket: { select: { deviceId: true, plantId: true, plant: { select: { name: true } } } } },
    });
    return traces.map((t) => ({
      ticketId: t.ticketId,
      deviceId: t.ticket?.deviceId ?? null,
      plantId: t.ticket?.plantId != null ? String(t.ticket.plantId) : null,
      plantName: t.ticket?.plant?.name ?? null,
      poolEmptyReason: (t.trace as { poolEmptyReason?: string } | null)?.poolEmptyReason ?? null,
    }));
  }

  /** Work held past today, with the vehicle report behind it when there is one. */
  private async heldToday(zoneId: bigint, day: Date): Promise<TodayHold[]> {
    const tickets = await this.prisma.ticket.findMany({
      where: { status: 'OPEN', assignmentState: 'UNASSIGNED', deferredUntil: { gt: day }, plant: { zoneId } },
      orderBy: { deferredUntil: 'asc' },
      select: { ticketId: true, deviceId: true, deferredUntil: true, plant: { select: { name: true } } },
    });
    if (tickets.length === 0) return [];
    const reports = await this.prisma.vehicleUnavailabilityReport.findMany({
      where: { ticketId: { in: tickets.map((t) => t.ticketId) }, status: 'OPEN' },
      select: { ticketId: true, expectedFrom: true, decidedBy: true },
    });
    const byTicket = new Map(reports.map((r) => [r.ticketId, r]));
    return tickets.map((t) => ({
      ticketId: t.ticketId,
      deviceId: t.deviceId,
      plantName: t.plant?.name ?? null,
      heldUntil: t.deferredUntil!.toISOString().slice(0, 10),
      expectedFrom: byTicket.get(t.ticketId)?.expectedFrom?.toISOString() ?? null,
      decidedBy: byTicket.get(t.ticketId)?.decidedBy ?? null,
    }));
  }

  /** CRITICAL work the engine refused to self-authorise an overload for (#258 Q-B). */
  private async escalationsOpen(zoneId: bigint): Promise<TodayEscalation[]> {
    const rows = await this.prisma.intradayInsertion.findMany({
      where: { zoneId, status: 'ESCALATION_REQUIRED' },
      orderBy: { createdAt: 'desc' },
      select: { insertionId: true, ticketId: true, slaBucket: true, createdAt: true },
    });
    return rows.map((r) => ({
      insertionId: String(r.insertionId),
      ticketId: r.ticketId,
      slaBucket: r.slaBucket,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * How many changes were made to today's plan — the header chip.
   *
   * Counted off `batch_assignment_tickets` directly, both legs, which is only honest because #283 put
   * an actor on the add side. The itemised list is #284's `changes-today` read; this is just its size.
   */
  private async changesTodayCount(zoneId: bigint, day: Date): Promise<number> {
    const dayStart = new Date(day.getTime() - 5.5 * 3600_000);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const where = { batch: { schedule: { zoneId } } };
    const [adds, removes] = await Promise.all([
      this.prisma.batchAssignmentTicket.count({
        where: { ...where, createdAt: { gte: dayStart, lt: dayEnd }, addedBy: { not: null } },
      }),
      this.prisma.batchAssignmentTicket.count({
        where: { ...where, removedAt: { gte: dayStart, lt: dayEnd }, removedBy: { not: null } },
      }),
    ]);
    return adds + removes;
  }

  /** The below-threshold count the run recorded. A count, not a list — see `policyWithheld` above. */
  private async policyWithheldCount(zoneId: bigint, day: Date): Promise<number> {
    const row = await this.prisma.dispatchRunZone.findFirst({
      where: { zoneId, run: { startedAt: { gte: day, lt: new Date(day.getTime() + 86_400_000) } } },
      orderBy: { runId: 'desc' },
      select: { withheldBelowThreshold: true },
    });
    return row?.withheldBelowThreshold ?? 0;
  }
}
