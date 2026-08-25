import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SUPERSEDED_RECOMMENDATION_STATUSES } from '../recommender/recommendation-status';
import { committedDayLoad } from './committed-day-load';
import { LIVE_SCHEDULE_STATUSES } from './schedule-status';

export interface ZmScope {
  role: string;
  zoneId: number | null;
}

export interface ZmScheduleRow {
  scheduleId: string;
  seId: string;
  /** SE display name (Issue 122b) — the operator-facing identity; the uuid stays the key. */
  seName: string | null;
  zoneId: string;
  zoneName: string | null;
  dateFrom: string;
  dateTo: string;
  status: string;
  batchCount: number;
  ticketCount: number;
}

export interface ZoneEngineerRow {
  engineerId: string;
  /** SE display name (Issue 122b) — pickers should never show a bare uuid. */
  name: string | null;
  coverageType: string;
  zoneId: string;
  /**
   * #269 — live day-plan stops the SE is already carrying for the requested day, from the one
   * {@link committedDayLoad} definition the recommender enforces against. The numerator
   * `dailyCapacity` never had: every picker fed by this row shows `committed / dailyCapacity`, and
   * `committed >= dailyCapacity` is marked but **never blocked** (#258 Q2 — overload is an
   * administrative right, so it is a seen decision rather than a refused one).
   */
  committed: number;
  dailyCapacity: number;
  isActive: boolean;
}

export interface TicketReasoning {
  companyTier: string | null;
  deviceBucket: string | null;
  companyPriorityRank: string | null;
  clusterMultiplier: number | null;
}

/**
 * Ungated per-ticket state on a schedule stop (Issue 79). Sourced independently of the gated
 * "Why suggested?" {@link TicketReasoning}: `slaBucket` from the live `device_states`, `companyTier`
 * denormalised on the ticket, `partialRecovery` from a PARTIAL_RECOVERY verification outcome (Issue 18).
 * Drives the reference-12 per-ticket PARTIAL / CRITICAL / tier card badges without unhiding the reasoning.
 */
export interface UngatedTicketState {
  slaBucket: string | null;
  companyTier: string | null;
  partialRecovery: boolean;
}

export interface ZmDetailStopTicket extends UngatedTicketState {
  ticketId: string;
  sortOrder: number;
  reasoning: TicketReasoning | null;
}

export interface ZmDetailStop {
  batchId: string;
  stopSequence: number;
  plantId: string;
  plantName: string;
  status: string;
  deviceCount: number;
  tickets: ZmDetailStopTicket[];
}

export interface ZmScheduleDetail {
  scheduleId: string;
  seId: string;
  seName: string | null;
  status: string;
  dateFrom: string;
  dateTo: string;
  stops: ZmDetailStop[];
}

/**
 * ZM Batch-Schedule monitoring reads (Issue 13a AC#1/#2). Per-SE schedule rows and the ordered-stop
 * detail with the per-ticket "Why suggested?" Recommender reasoning. Monitoring only — no approval or
 * countdown semantics. Zone-scoped: a ZONAL_MANAGER sees only their own zone; cross-zone roles
 * (CENTRAL_SERVICE_MANAGER / OPERATIONS_HEAD) see all zones.
 */
@Injectable()
export class ZmScheduleQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async listSchedules(scope: ZmScope): Promise<ZmScheduleRow[]> {
    const schedules = await this.prisma.workSchedule.findMany({
      where: { status: { in: [...LIVE_SCHEDULE_STATUSES] }, ...this.zoneFilter(scope) },
      orderBy: [{ zoneId: 'asc' }, { seId: 'asc' }],
      include: {
        engineer: { select: { user: { select: { name: true } } } },
        zone: { select: { name: true } },
        batches: {
          where: { status: { in: ['AUTO_ASSIGNED', 'OVERRIDDEN'] } },
          include: { tickets: { where: { removedAt: null }, select: { id: true } } },
        },
      },
    });

    return schedules.map((s) => ({
      scheduleId: String(s.scheduleId),
      seId: s.seId,
      seName: s.engineer?.user?.name ?? null,
      zoneId: String(s.zoneId),
      zoneName: s.zone?.name ?? null,
      dateFrom: s.dateFrom.toISOString().slice(0, 10),
      dateTo: s.dateTo.toISOString().slice(0, 10),
      status: s.status,
      batchCount: s.batches.length,
      ticketCount: s.batches.reduce((n, b) => n + b.tickets.length, 0),
    }));
  }

  async getScheduleDetail(engineerId: string, scope: ZmScope): Promise<ZmScheduleDetail | null> {
    const schedule = await this.prisma.workSchedule.findFirst({
      where: { seId: engineerId, status: { in: [...LIVE_SCHEDULE_STATUSES] }, ...this.zoneFilter(scope) },
      orderBy: { dispatchedAt: 'desc' },
      include: {
        engineer: { select: { user: { select: { name: true } } } },
        batches: {
          where: { status: { in: ['AUTO_ASSIGNED', 'OVERRIDDEN'] } },
          orderBy: { stopSequence: 'asc' },
          include: {
            plant: { select: { name: true } },
            tickets: {
              where: { removedAt: null },
              orderBy: { sortOrder: 'asc' },
              select: { ticketId: true, sortOrder: true },
            },
          },
        },
      },
    });
    if (!schedule) return null;

    const ticketIds = schedule.batches.flatMap((b) => b.tickets.map((t) => t.ticketId));
    const reasoning = await this.reasoningByTicket(ticketIds);
    const state = await this.stateByTicket(ticketIds);

    // #179 slice 3 — same hollow-stop defect as the SE day plan (`day-plan-query.service.ts`): a
    // batch every one of whose tickets has been removed (a bulk unassign or an override) carries no
    // live work and must not render above the SE's real remaining stops.
    const stops: ZmDetailStop[] = schedule.batches
      .filter((b) => b.tickets.length > 0)
      .map((b) => ({
        batchId: String(b.batchId),
        stopSequence: b.stopSequence,
        plantId: String(b.plantId),
        plantName: b.plant.name,
        status: b.status,
        deviceCount: b.tickets.length,
        tickets: b.tickets.map((t) => ({
          ticketId: t.ticketId,
          sortOrder: t.sortOrder,
          ...(state.get(t.ticketId) ?? { slaBucket: null, companyTier: null, partialRecovery: false }),
          reasoning: reasoning.get(t.ticketId) ?? null,
        })),
      }));

    return {
      scheduleId: String(schedule.scheduleId),
      seId: schedule.seId,
      seName: schedule.engineer?.user?.name ?? null,
      status: schedule.status,
      dateFrom: schedule.dateFrom.toISOString().slice(0, 10),
      dateTo: schedule.dateTo.toISOString().slice(0, 10),
      stops,
    };
  }

  /**
   * Manager-readable, zone-scoped active SE list — the target-SE picker source for Swap / Reassign /
   * Split overrides and the Critical-queue assign (Issue 13b). A ZONAL_MANAGER sees only their own
   * zone; cross-zone roles (CSM / Operations Head) see all. Distinct from the Ops-Head-only
   * `/api/org/engineers`, which a ZM cannot read.
   */
  async listZoneEngineers(scope: ZmScope, now: Date = new Date()): Promise<ZoneEngineerRow[]> {
    const engineers = await this.prisma.engineerMaster.findMany({
      where: { isActive: true, ...this.zoneFilter(scope) },
      orderBy: { engineerId: 'asc' },
      include: { user: { select: { name: true } } },
    });
    // #269 — one extra query for the whole picker, scoped to the SEs actually being returned. The
    // load is deliberately NOT zone-filtered: `daily_capacity` caps the engineer's day, and a
    // floating SE's work in a neighbouring zone is still work they have to do.
    const load = await committedDayLoad(this.prisma, now, { seIds: engineers.map((e) => e.engineerId) });
    return engineers.map((e) => ({
      engineerId: e.engineerId,
      name: e.user?.name ?? null,
      coverageType: e.coverageType,
      zoneId: String(e.zoneId),
      committed: load.get(e.engineerId) ?? 0,
      dailyCapacity: e.dailyCapacity,
      isActive: e.isActive,
    }));
  }

  private zoneFilter(scope: ZmScope): { zoneId?: bigint } {
    return scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? { zoneId: BigInt(scope.zoneId) } : {};
  }

  /**
   * Ungated per-ticket badge state (Issue 79) — live `device_states.sla_bucket`, the ticket's
   * denormalised `company_tier`, and whether any verification run reached PARTIAL_RECOVERY. Deliberately
   * distinct from {@link reasoningByTicket}: this is the *un*gated source the stop-card badges read
   * without the ZM expanding "Why suggested?".
   */
  private async stateByTicket(ticketIds: string[]): Promise<Map<string, UngatedTicketState>> {
    if (ticketIds.length === 0) return new Map();
    const tickets = await this.prisma.ticket.findMany({
      where: { ticketId: { in: ticketIds } },
      select: {
        ticketId: true,
        companyTier: true,
        device: { select: { state: { select: { slaBucket: true } } } },
        verificationRuns: { select: { outcome: true } },
      },
    });
    const map = new Map<string, UngatedTicketState>();
    for (const t of tickets) {
      map.set(t.ticketId, {
        slaBucket: t.device.state?.slaBucket ?? null,
        companyTier: t.companyTier,
        partialRecovery: t.verificationRuns.some((v) => v.outcome === 'PARTIAL_RECOVERY'),
      });
    }
    return map;
  }

  /** Latest recommendation reasoning per ticket (the "Why suggested?" chip source). */
  private async reasoningByTicket(ticketIds: string[]): Promise<Map<string, TicketReasoning>> {
    if (ticketIds.length === 0) return new Map();
    const recs = await this.prisma.recommendation.findMany({
      // #286 — a RETIRED row is newer than the DISPATCHED one that actually explains the placement, so
      // latest-wins would start answering "why suggested?" with the reasoning of a run that placed
      // nothing. Excluded here, which is exactly the answer this read gave while the row was deleted.
      where: { ticketId: { in: ticketIds }, status: { notIn: SUPERSEDED_RECOMMENDATION_STATUSES } },
      orderBy: { recommendationId: 'desc' },
    });
    const map = new Map<string, TicketReasoning>();
    for (const r of recs) {
      if (map.has(r.ticketId)) continue; // keep the latest (desc order)
      const b = (r.scoreBreakdown ?? {}) as Record<string, unknown>;
      map.set(r.ticketId, {
        companyTier: r.companyTier ?? null,
        deviceBucket: r.deviceBucket ?? null,
        companyPriorityRank: (b.companyPriorityRank as string) ?? null,
        clusterMultiplier: typeof b.clusterMultiplier === 'number' ? b.clusterMultiplier : null,
      });
    }
    return map;
  }
}
