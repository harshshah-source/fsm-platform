import { Injectable } from '@nestjs/common';
import { istDate } from '../common/ist-day';
import { PrismaService } from '../prisma/prisma.service';
import { SUPERSEDED_RECOMMENDATION_STATUSES } from '../recommender/recommendation-status';
import { isSystemAddSource } from './add-source';
import { committedDayLoad } from './committed-day-load';
import { LIVE_SCHEDULE_STATUSES } from './schedule-status';
import { type DayPlanWarehousePickupStop, warehousePickupStop } from './warehouse-pickup';

export interface ZmScope {
  role: string;
  zoneId: number | null;
}

/**
 * One committed stop on a listed schedule, at the fidelity a board cell needs to draw it — plant,
 * status, and the tickets with the provenance the chip grammar reads (#282 R2 / #283).
 *
 * Deliberately **not** {@link ZmDetailStop}: that shape carries the gated "Why suggested?"
 * {@link TicketReasoning}, which costs two extra queries per schedule and answers a question a board
 * cell never asks. This one is assembled entirely from rows {@link ZmScheduleQueryService.listSchedules}
 * already fetches to compute its counts, so it adds a wider `select` and not a single query.
 */
export interface ZmScheduleRowStop {
  batchId: string;
  stopSequence: number;
  plantId: string;
  plantName: string;
  status: string;
  tickets: {
    ticketId: string;
    sortOrder: number;
    addSource: string | null;
    addedBy: string | null;
    coverageTypeAtAssign: string | null;
    /**
     * The server's own reading of `addSource` — the same posture `GET /dispatch/today` takes, and for
     * the same reason: the "which sources are the engine's" rule lives in `add-source.ts` and the
     * client never re-derives it. NULL provenance is **not** system (it is unknown), which is exactly
     * the distinction a client-side `includes()` is one careless edit away from losing.
     */
    systemPlaced: boolean;
  }[];
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
  /**
   * The stops themselves — present only when the caller asked for `detail`, absent otherwise.
   *
   * **Why this exists.** The Scheduler Console renders a non-today column from this read, and until
   * now the read could answer only in counts, so a future day could say "1 stop · 1 device" and never
   * *which* device. That is tolerable for a context column and is not tolerable for the day an
   * operator just moved a ticket to: they need to see the ticket they moved, in the cell they dropped
   * it on, or the move is indistinguishable from the silence the old defer produced.
   *
   * Opt-in rather than always-on for #284 §D's reason, unchanged: a caller that does not ask gets
   * byte-identical bytes to what it got before.
   */
  stops?: ZmScheduleRowStop[];
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
  /**
   * #366 — the Zone Warehouse pickup the SE makes before their first plant, or `null` when nothing
   * is waiting. Its own field rather than a member of `stops`, deliberately: `ZmDetailStop` is read
   * by the Console board and the override surfaces as *the batch a stop is*, and a pickup is not a
   * batch — it has no `batchId` to reorder, remove or reassign. The page renders it at sequence 0
   * ahead of the plant stops, which is what the approved design pins
   * (`docs/ui/desktop/approved-designs/warehouse-pickup-stop.html`). The SE-facing read
   * (`DayPlanQueryService`) puts it in `stops` as a discriminated `kind`, because there nothing
   * treats a stop as a batch.
   */
  pickup: DayPlanWarehousePickupStop | null;
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

  /**
   * #284 §D — an optional operating-day filter, and the reason it is optional.
   *
   * This read has never had a date predicate: it filters on live status alone, so a never-closed plan
   * from last week comes back beside today's while the nav row, the page copy and
   * `DispatchTimelineNote` all promise "today". `opts.date` applies the same
   * `dateFrom <= day <= dateTo` rule `DayPlanQueryService` has always used for the SE-facing read.
   *
   * **Additive, never a new default** (#284 AC10): omitting it returns exactly what it always
   * returned. Making "today" the default would silently narrow every existing caller — a page, a link
   * and a test each expecting the all-live list — which is a behaviour change wearing a bugfix's
   * clothes. The surface that promises "today" passes the parameter; the endpoint keeps its word to
   * everyone else.
   */
  async listSchedules(scope: ZmScope, opts: { date?: Date; detail?: boolean } = {}): Promise<ZmScheduleRow[]> {
    const schedules = await this.prisma.workSchedule.findMany({
      where: {
        status: { in: [...LIVE_SCHEDULE_STATUSES] },
        ...this.zoneFilter(scope),
        ...dayCoverageFilter(opts.date),
      },
      orderBy: [{ zoneId: 'asc' }, { seId: 'asc' }],
      include: {
        engineer: { select: { user: { select: { name: true } } } },
        zone: { select: { name: true } },
        batches: {
          where: { status: { in: ['AUTO_ASSIGNED', 'OVERRIDDEN'] } },
          orderBy: { stopSequence: 'asc' },
          // `detail` widens the columns read off rows this query already walks — it adds no round
          // trip and no join the count path did not already make. `plant` is the one genuine
          // addition, and it is skipped entirely when detail was not asked for.
          include: {
            ...(opts.detail ? { plant: { select: { name: true } } } : {}),
            tickets: {
              where: { removedAt: null },
              orderBy: { sortOrder: 'asc' },
              select: opts.detail
                ? { id: true, ticketId: true, sortOrder: true, addSource: true, addedBy: true, coverageTypeAtAssign: true }
                : { id: true },
            },
          },
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
      ...(opts.detail
        ? {
            // Same hollow-stop rule `getScheduleDetail` and the SE day plan apply: a batch whose every
            // ticket has been removed carries no live work and is not a stop anyone will make.
            stops: s.batches
              .filter((b) => b.tickets.length > 0)
              .map((b) => ({
                batchId: String(b.batchId),
                stopSequence: b.stopSequence,
                plantId: String(b.plantId),
                plantName: (b as { plant?: { name: string } | null }).plant?.name ?? String(b.plantId),
                status: b.status,
                tickets: b.tickets.map((t) => {
                  const d = t as typeof t & {
                    ticketId: string;
                    sortOrder: number;
                    addSource: string | null;
                    addedBy: string | null;
                    coverageTypeAtAssign: string | null;
                  };
                  return {
                    ticketId: d.ticketId,
                    sortOrder: d.sortOrder,
                    addSource: d.addSource,
                    addedBy: d.addedBy,
                    coverageTypeAtAssign: d.coverageTypeAtAssign,
                    systemPlaced: isSystemAddSource(d.addSource),
                  };
                }),
              })),
          }
        : {}),
    }));
  }

  async getScheduleDetail(engineerId: string, scope: ZmScope): Promise<ZmScheduleDetail | null> {
    const schedule = await this.prisma.workSchedule.findFirst({
      where: { seId: engineerId, status: { in: [...LIVE_SCHEDULE_STATUSES] }, ...this.zoneFilter(scope) },
      orderBy: { dispatchedAt: 'desc' },
      include: {
        engineer: { select: { user: { select: { name: true } } } },
        // #366 — the zone names the warehouse the SE collects from; there is no warehouse row to read.
        zone: { select: { name: true } },
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

    // #366 — the same derivation the SE's own plan uses, over the same live tickets, so the
    // dispatcher checking the plan and the engineer working it are told the same thing.
    const pickup = await warehousePickupStop(this.prisma, {
      ticketIds: stops.flatMap((s) => s.tickets.map((t) => t.ticketId)),
      zoneName: schedule.zone.name,
    });

    return {
      scheduleId: String(schedule.scheduleId),
      seId: schedule.seId,
      seName: schedule.engineer?.user?.name ?? null,
      status: schedule.status,
      dateFrom: schedule.dateFrom.toISOString().slice(0, 10),
      dateTo: schedule.dateTo.toISOString().slice(0, 10),
      stops,
      pickup,
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

/**
 * #284 §D — `dateFrom <= day <= dateTo`, or nothing at all when no day was asked for.
 *
 * `istDate` because `date_from`/`date_to` are `@db.Date`: Postgres DATE carries no timezone and Prisma
 * marshals it to UTC midnight, so the comparison value has to be UTC midnight *of the IST calendar
 * date* (`ist-day.ts` states the rule and the two functions that get it wrong).
 */
function dayCoverageFilter(date: Date | undefined): { dateFrom?: { lte: Date }; dateTo?: { gte: Date } } {
  if (date === undefined) return {};
  const day = istDate(date);
  return { dateFrom: { lte: day }, dateTo: { gte: day } };
}
