import { BadRequestException, ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import { istDate } from '../common/ist-day';
import { currentAssigneesFor } from '../intraday/current-assignee';
import { PrismaService } from '../prisma/prisma.service';
import { readAgingThresholdHours } from '../settings/aging-threshold';
import { CHRONIC_FAILURE_CYCLE_THRESHOLD } from '../ticketing/chronic-device';
import { isSystemAddSource } from './add-source';
import { committedDayPlan } from './committed-day-load';
import { REMOVAL_REASONS } from './removal-reason';
import { liveScheduleFilter } from './schedule-status';
import {
  NoConflictSoftStatePort,
  SOFT_STATE_CONFLICT,
  type SoftStateConflictPort,
} from './soft-state-conflict';
import {
  deriveTicketActionStatus,
  hoursSinceAssignment,
  type TicketActionStatus,
} from './ticket-action-status';
import type { ZmScope } from './zm-schedule-query.service';

/**
 * A ticket as it sits on a stop — persisted order, persisted provenance, and (since #295) the
 * physical identity a dispatcher actually reasons about.
 *
 * The identity fields are a **read-model enrichment, not a second source**: they come from the joins
 * `ticket-query.service.ts` has always used, batched once over the whole payload. Nothing here is
 * decided; the one derived field, `actionStatus`, is a pure function of two facts and one published
 * threshold, so the client renders a verdict rather than recomputing one.
 */
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
  /**
   * How many failure cycles this ticket's device has ever had — the chronic predicate's input.
   *
   * **A number, not a boolean**, so the surface can say *how* chronic ("×4") rather than only *that* it
   * is, and so the threshold lives in one place instead of being re-derived per client. Null when the
   * ticket resolves to no device.
   */
  failureCycles: number | null;

  // ── #295 — the work card's physical identity ────────────────────────────────────────────────────
  /** The unit in the field. The label a dispatcher recognises — never the key; `ticketId` is that. */
  deviceId: string | null;
  /** From `vehicles.vehicle_no` via the ticket's vehicle. Null when the ticket resolves to none. */
  vehicleNo: string | null;
  /** `company_master.name`. The tier already travelled; the name is what an operator says out loud. */
  companyName: string | null;
  /** `transporters.name`, reached through the vehicle. Null when either link is absent. */
  transporterName: string | null;
  /**
   * `device_states.inactivity_hours` — how long the *device* has been silent, as a number.
   *
   * **Null is "never recomputed", and is not zero.** A state row that has never been through
   * `DeviceStateService.recompute` knows nothing about this device's silence, and rendering that as
   * `0h` would tell a dispatcher the unit had just reported in. Precedent for the same care:
   * `assignable-work-query.service.ts:98-105`.
   *
   * **This is not the aging clock.** It is displayed, and it is the reason the ticket exists — but
   * `actionStatus` is measured from `assignedAt`. See `ticket-action-status.ts`.
   */
  inactivityHours: number | null;
  /** When this ticket became this engineer's — `batch_assignment_tickets.created_at`, ISO. */
  assignedAt: string;
  /**
   * This assignment has been worked. True on either proof, and both are needed:
   *
   * - an **unresolved `TROUBLESHOOT_STARTED`** — the engineer is on it now; or
   * - a **troubleshooting report filed since this assignment began** — they were on it and finished.
   *
   * Not ON_SITE (arriving is not starting), and emphatically not "it has been assigned". The second
   * clause exists because submitting a report *resolves* the soft state while the work stays on the
   * plan until verification — see `submittedInWindow`.
   */
  troubleshootingStarted: boolean;
  /** The dispatcher's one-word verdict. Derived here so no client owns the rule. */
  actionStatus: TicketActionStatus;
}

/**
 * #295 — one visible card's physical identity on a **non-today** column.
 *
 * The `TodayTicket` fields that a day-scoped source can honestly answer, and not one more: no
 * provenance (the column's own read carries that), no SLA bucket, and above all no `actionStatus`.
 */
export interface CardSummary {
  ticketId: string;
  deviceId: string | null;
  vehicleNo: string | null;
  companyName: string | null;
  transporterName: string | null;
  inactivityHours: number | null;
}

/** The cap on one `cardSummaries` request — a bounded id list, because it becomes a bounded query. */
export const CARD_SUMMARY_LIMIT = 500;

/** What one batched identity pass resolves per ticket, before it is spread onto a card (#295). */
interface TicketIdentity {
  deviceId: string | null;
  slaBucket: string | null;
  inactivityHours: number | null;
  companyName: string | null;
  vehicleNo: string | null;
  transporterName: string | null;
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

/**
 * The header's counters. Every one is a count of something in this payload or beside it.
 *
 * **They are never summed.** Eight populations with different owners and different next actions do not
 * add up to one "not dispatched" number, and a surface that adds them invites an operator to chase a
 * total nobody can act on.
 *
 * **B1 — the last two are why this interface grew.** The funnel always had more than six populations:
 * `componentBlockedWithheld` and `bucketlessDropped` are recorded per run *and per zone*, and were
 * simply not published here — so the strip implied an exhaustiveness it did not have. Both are
 * `number | null`, and **null is "this run did not record it", not zero**: the columns are nullable for
 * runs that predate #177, and drawing an unrecorded population as an empty one is the same lie the
 * provenance grammar exists to prevent.
 */
export interface TodaySituation {
  placed: number;
  unassignable: number;
  held: number;
  criticalNeedsYou: number;
  overCapacity: number;
  changesToday: number;
  /** Tickets the run withheld because the device is component-blocked. Null = not recorded by this run. */
  componentBlockedWithheld: number | null;
  /** Tickets dropped before ranking for having no SLA bucket. Null = not recorded by this run. */
  bucketlessDropped: number | null;
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
  /** #295 — the chronic count, which the client has always declared and never received. */
  failureCycles: number | null;
}

export interface TodayHold {
  ticketId: string;
  deviceId: string | null;
  plantName: string | null;
  heldUntil: string;
  /** From the ticket's OPEN vehicle-unavailability report, when one backs the hold. */
  expectedFrom: string | null;
  /** Who approved the *vehicle-unavailability report* behind this hold — and nothing else. */
  decidedBy: string | null;
  /**
   * Who deferred the ticket, if a manager did (`DEFER_TICKET`). Separate from `decidedBy` on purpose:
   * that field answers the vehicle-report question, and one field standing for two different decisions
   * is how a rail starts telling a plausible lie about which one happened.
   */
  deferredBy: string | null;
  /** Their display name; null when the id resolves to no user — render the id, never a guess (B7). */
  deferredByName: string | null;
  /** The reason they were made to type. Null for a hold no manager deferred, and for pre-#241 history. */
  deferredReason: string | null;
  failureCycles: number | null;
}

/**
 * #286 — this zone's same-day recovery state, when it has one. `null` on an ordinary day.
 *
 * The bound on automatic re-dispatch is only acceptable because it is visible: a zone that lost its
 * morning and was recovered, or that was given up on after three attempts, must not read the same as a
 * zone that had a quiet day. The state is the whole message; `attempts` and `lastError` are what make
 * it actionable rather than alarming.
 *
 * #319 widened what reaches here without changing the shape: a zone lost to a **contained** error —
 * one that threw inside a live run, or whose claim was still open when the run unwound — is now marked
 * exactly as a crashed zone is. So this field no longer means "the process died"; it means the zone
 * lost its dispatch, and the cockpit's wording follows it.
 */
export interface TodayRecovery {
  /** `PENDING` | `RECOVERED` | `EXHAUSTED` | `EXPIRED`. */
  state: string;
  attempts: number;
  markedAt: string;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export interface TodayEscalation {
  insertionId: string;
  ticketId: string;
  slaBucket: string | null;
  createdAt: string;
  /**
   * #288 — why this row exists. `SYSTEM_CRITICAL` is #268's "no capacity-eligible engineer";
   * `SE_UNAVAILABLE` is work an engineer became unavailable on. The strip above this list asserts a
   * cause in words, so it has to be able to tell them apart — one sentence over a mixed list would be
   * wrong about half of it.
   */
  insertionType: string;
  /**
   * The engineer the ticket is live on, or null. Non-null means the queue's Assign cannot resolve it
   * (`assignTicket` refuses an assigned ticket) and the door that works is a reassign on that
   * engineer's day plan.
   */
  assignedSeId: string | null;
  assignedSeName: string | null;
}

export interface DispatchTodayView {
  operatingDay: string;
  /**
   * **The rules the cards are painted by, published with them.**
   *
   * `chronicThreshold` is the #295 half of a defect worth naming: the admin client has declared it
   * *required* since Phase 3.4 and this payload never sent it, so `failureCycles >= undefined` was
   * permanently false and the `CHR ×n` token could not light for any ticket in production. It read as
   * working only because six test fixtures hand-wrote the number. `agingThresholdHours` ships beside
   * it under the same rule, so the new status field cannot inherit the same silent hole: the server
   * owns the rule, the client renders the verdict, and a threshold that never arrives is a visible
   * bug rather than a permanently-false comparison.
   */
  chronicThreshold: number;
  /** Hours an assignment may sit untouched before `actionStatus` turns AGING_UNTOUCHED (#295). */
  agingThresholdHours: number;
  zone: { zoneId: string; name: string };
  run: TodayRun | null;
  /** #286 — set only when this zone was owed a re-dispatch today. Null is "nothing crashed". */
  recovery: TodayRecovery | null;
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
  private readonly softStates: SoftStateConflictPort;

  constructor(
    private readonly prisma: PrismaService,
    /**
     * Optional, matching `OverrideService`'s constructor: the many specs that build this service with
     * nothing but a Prisma client keep working, and a board that cannot read soft states reports
     * nothing started — which renders as untouched, never as a fabricated green.
     */
    @Optional() @Inject(SOFT_STATE_CONFLICT) softStates?: SoftStateConflictPort,
  ) {
    this.softStates = softStates ?? new NoConflictSoftStatePort();
  }

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
    const [identity, returnDue, load, availability, started, agingThresholdHours] = await Promise.all([
      // #295 — one batched read for every card's identity, replacing the narrower `bucketByTicket`.
      this.identityByTicket(ticketIds),
      this.returnDueToday(ticketIds, day),
      // One batched query for the whole zone — the same function the engine enforces against.
      committedDayPlan(this.prisma, day, { seIds }),
      this.availabilityBySe(seIds, now),
      // One batched soft-state read for the whole board. TROUBLESHOOT_STARTED only — an engineer who
      // has arrived and not begun has not started the work (`soft-state-conflict.ts`).
      this.softStates.activeTroubleshootStartedTicketIds(ticketIds),
      readAgingThresholdHours(this.prisma),
    ]);
    // Two more batched reads: one over the devices the identity pass resolved, one over the
    // assignment rows, so a finished job does not read as an untouched one (see `submittedInWindow`).
    const assignmentRows = schedules.flatMap((s) =>
      s.batches.flatMap((b) => b.tickets.map((t) => ({ ticketId: t.ticketId, assignedAt: t.createdAt }))),
    );
    const [failureCycles, submitted] = await Promise.all([
      this.failureCyclesByDevice([...identity.values()].map((i) => i.deviceId)),
      this.submittedInWindow(assignmentRows),
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
            tickets: b.tickets.map((t) => {
              const id = identity.get(t.ticketId);
              // Either proof that this assignment has been worked: the engineer is holding the state
              // now, or they already filed the report that resolved it. See `submittedInWindow`.
              const troubleshootingStarted = started.has(t.ticketId) || submitted.has(t.ticketId);
              return {
                ticketId: t.ticketId,
                sortOrder: t.sortOrder,
                slaBucket: id?.slaBucket ?? null,
                companyTier: t.ticket?.companyTier ?? null,
                addSource: t.addSource,
                addedBy: t.addedBy,
                addReason: t.addReason,
                coverageTypeAtAssign: t.coverageTypeAtAssign,
                systemPlaced: isSystemAddSource(t.addSource),
                returnDueToday: returnDue.has(t.ticketId),
                failureCycles: id?.deviceId != null ? (failureCycles.get(id.deviceId) ?? 0) : null,
                deviceId: id?.deviceId ?? null,
                vehicleNo: id?.vehicleNo ?? null,
                companyName: id?.companyName ?? null,
                transporterName: id?.transporterName ?? null,
                inactivityHours: id?.inactivityHours ?? null,
                assignedAt: t.createdAt.toISOString(),
                troubleshootingStarted,
                // The one derived field on this payload, and it is derived here rather than in React
                // so that "what makes a card yellow" has exactly one implementation.
                actionStatus: deriveTicketActionStatus({
                  troubleshootingStarted,
                  hoursSinceAssignment: hoursSinceAssignment(t.createdAt, now),
                  agingThresholdHours,
                }),
              };
            }),
          })),
      };
    });

    const [run, recovery, unassignable, held, escalations, changesToday, policyWithheld] = await Promise.all([
      this.latestRun(zoneId, day),
      this.recoveryToday(zoneId, day),
      this.unassignableToday(zoneId, day),
      this.heldToday(zoneId, day),
      this.escalationsOpen(zoneId),
      this.changesTodayCount(zoneId, day),
      this.policyWithheldCount(zoneId, day),
    ]);
    const funnelTail = await this.funnelTail(zoneId, day);

    // #295 — the rails carry the chronic count too, and both were publishing a hardcoded null. One
    // grouped query over both rails' devices, for the same reason the board's is one: the Work Pool's
    // chronic filter runs over every unassignable row in the zone, which can be four figures.
    const railCycles = await this.failureCyclesByDevice([
      ...unassignable.map((u) => u.deviceId),
      ...held.map((h) => h.deviceId),
    ]);
    const withCycles = <T extends { deviceId: string | null; failureCycles: number | null }>(row: T): T => ({
      ...row,
      failureCycles: row.deviceId != null ? (railCycles.get(row.deviceId) ?? 0) : null,
    });

    return {
      operatingDay: day.toISOString().slice(0, 10),
      chronicThreshold: CHRONIC_FAILURE_CYCLE_THRESHOLD,
      agingThresholdHours,
      zone: { zoneId: String(zone.zoneId), name: zone.name },
      run,
      recovery,
      engineers: lanes,
      situation: {
        placed: lanes.reduce((n, e) => n + e.stops.reduce((m, s) => m + s.tickets.length, 0), 0),
        unassignable: unassignable.length,
        held: held.length,
        criticalNeedsYou: escalations.length,
        overCapacity: lanes.filter((e) => e.overCapacity).length,
        changesToday,
        componentBlockedWithheld: funnelTail.componentBlockedWithheld,
        bucketlessDropped: funnelTail.bucketlessDropped,
      },
      rails: {
        unassignable: unassignable.map(withCycles),
        held: held.map(withCycles),
        policyWithheld: { count: policyWithheld, itemised: false },
      },
      escalations,
    };
  }

  /**
   * #295 — **the identity of work on a day that is not today**, for every visible card in one call.
   *
   * A committed future column is built from `GET /schedules?date=&detail=stops`, which returns ticket
   * ids and provenance and nothing physical. Asking per card would be one request per chip; widening
   * `/schedules` instead would grow a pan-zone read that four other surfaces consume. So the column
   * names its ids once and gets their identity back.
   *
   * **What this deliberately does not return is `actionStatus`.** Nobody has started work whose day
   * has not begun, and "untouched for six hours" said about Wednesday is not a fact about Wednesday.
   * The future column renders identity and its committed badge; the verdict belongs to the day the
   * work is live. Same rule as every other column: answer at the fidelity the source can honestly
   * reach, never one step past it.
   *
   * **Scoped like every other scheduler read.** The ids come from the client, which makes this an
   * enumeration surface unless it is clamped: the zone is checked exactly as `today()` checks it, and
   * rows are then filtered to tickets whose plant sits in that zone, so a guessed id from another
   * zone returns nothing rather than a fleet record.
   */
  async cardSummaries(
    scope: ZmScope,
    opts: { zoneId: bigint; ticketIds: string[] },
  ): Promise<{ summaries: CardSummary[] }> {
    if (scope.role === 'ZONAL_MANAGER' && scope.zoneId != null && BigInt(scope.zoneId) !== opts.zoneId) {
      throw new ForbiddenException({ code: 'ZONE_SCOPE_VIOLATION' });
    }
    // The cap is on what was **sent**, before de-duplication, so it agrees with the DTO's
    // `ArrayMaxSize` and cannot be walked past by repeating one id a hundred thousand times.
    if (opts.ticketIds.length > CARD_SUMMARY_LIMIT) {
      // Refused by name rather than truncated: a silently shortened answer leaves cards blank with
      // nothing on the wire to explain why, which is the class of quiet failure #295 exists to end.
      throw new BadRequestException({
        code: 'TOO_MANY_TICKETS',
        hint: `at most ${CARD_SUMMARY_LIMIT} ticket ids per request`,
      });
    }
    const ticketIds = [...new Set(opts.ticketIds)];
    if (ticketIds.length === 0) return { summaries: [] };

    const inZone = await this.prisma.ticket.findMany({
      where: { ticketId: { in: ticketIds }, plant: { zoneId: opts.zoneId } },
      select: { ticketId: true },
    });
    const identity = await this.identityByTicket(inZone.map((t) => t.ticketId));

    return {
      summaries: [...identity.entries()].map(([ticketId, id]) => ({
        ticketId,
        deviceId: id.deviceId,
        vehicleNo: id.vehicleNo,
        companyName: id.companyName,
        transporterName: id.transporterName,
        inactivityHours: id.inactivityHours,
      })),
    };
  }

  /**
   * #286 — the zone's recovery mark for the operating day, if there is one.
   *
   * Scoped to `day` deliberately: yesterday's loss is history, not today's situation, and a rail that
   * kept showing it would train the operator to ignore the rail.
   */
  private async recoveryToday(zoneId: bigint, day: Date): Promise<TodayRecovery | null> {
    const mark = await this.prisma.dispatchZoneRecovery.findUnique({
      where: { zoneId_businessDate: { zoneId, businessDate: day } },
    });
    if (!mark) return null;
    return {
      state: mark.state,
      attempts: mark.attempts,
      markedAt: mark.markedAt.toISOString(),
      lastAttemptAt: mark.lastAttemptAt?.toISOString() ?? null,
      lastError: mark.lastError,
    };
  }

  /**
   * **Everything a work card names, in two queries** (#295).
   *
   * This grew out of `bucketByTicket`, which read the same two tables for the SLA bucket alone. The
   * join is not new either — `ticket-query.service.ts` (`FROM_JOINS`) has always reached
   * device_states / plants / company_master / vehicles / transporters this way, and
   * `MeTicketsQueryService` proves the same shape through Prisma `include` for the SE app. What is new
   * is only that the Console gets it too, batched over the whole board.
   *
   * **Two queries, not two per ticket.** A board routinely carries a few hundred cards; six joins per
   * chip is the difference between a page and an outage, which is why every neighbour on this service
   * (`returnDueToday`, `availabilityBySe`, the name lookup in `heldToday`) is written the same way.
   *
   * The plant is deliberately absent: it is a property of the *stop*, already on `TodayStop`, and
   * copying it onto every ticket would invite a card to disagree with the stop it sits in.
   */
  private async identityByTicket(ticketIds: string[]): Promise<Map<string, TicketIdentity>> {
    if (ticketIds.length === 0) return new Map();
    const rows = await this.prisma.ticket.findMany({
      where: { ticketId: { in: ticketIds } },
      select: {
        ticketId: true,
        deviceId: true,
        company: { select: { name: true } },
        vehicle: { select: { vehicleNo: true, transporter: { select: { name: true } } } },
      },
    });
    const states = await this.prisma.deviceState.findMany({
      where: { deviceId: { in: rows.map((r) => r.deviceId).filter((d): d is string => d != null) } },
      select: { deviceId: true, slaBucket: true, inactivityHours: true },
    });
    const byDevice = new Map(states.map((s) => [s.deviceId, s]));
    return new Map(
      rows.map((r) => {
        const state = r.deviceId ? byDevice.get(r.deviceId) : undefined;
        return [
          r.ticketId,
          {
            deviceId: r.deviceId ?? null,
            slaBucket: state?.slaBucket ?? null,
            // `Decimal | null` → `number | null`. **Never `Number(null) === 0`**: null means the state
            // row has never been recomputed, and "silent for 0 hours" is a different, wrong claim.
            inactivityHours: state?.inactivityHours != null ? Number(state.inactivityHours) : null,
            companyName: r.company?.name ?? null,
            vehicleNo: r.vehicle?.vehicleNo ?? null,
            transporterName: r.vehicle?.transporter?.name ?? null,
          },
        ];
      }),
    );
  }

  /**
   * **Tickets whose current assignment has already been worked and filed** — the other half of
   * "somebody is on this".
   *
   * Reading the soft state alone was not enough, and the reason is a real sequence rather than a
   * hypothetical. Submitting a troubleshooting report **resolves** every unresolved soft state for
   * that `(ticket, se)` pair in the same transaction (`troubleshoot-submission.service.ts:157-160`,
   * stamped `FORM_SUBMITTED`) — while the assignment row stays live: nothing retires it until a ZM
   * makes a verification decision (`close-assignment.ts`, called only from the terminal paths), and
   * the ticket sits at `VERIFICATION_PENDING`, which is not a resolved status.
   *
   * So on the literal rule, the moment an engineer finished the job their card flipped from green
   * back to **red**, then aged to amber — telling a dispatcher to chase work that is done and waiting
   * on their own colleague. A filed report is proof that troubleshooting started; that it also
   * finished does not make it untouched.
   *
   * **Bounded to the current assignment window**, the same bound #244 uses to decide an attempt was
   * *reached*: a report filed against some earlier dispatch of the same ticket says nothing about
   * this one, and letting it vouch would leave a device permanently green across every future
   * assignment. The window's start is `batch_assignment_tickets.created_at` — the row is live
   * (`removedAt: null`), so there is no end bound to apply.
   *
   * One query for the whole board, compared in memory, in the same batched idiom as its neighbours.
   */
  private async submittedInWindow(rows: { ticketId: string; assignedAt: Date }[]): Promise<Set<string>> {
    if (rows.length === 0) return new Set();
    const assignedAt = new Map(rows.map((r) => [r.ticketId, r.assignedAt]));
    const submissions = await this.prisma.troubleshootingSubmission.findMany({
      where: { ticketId: { in: [...assignedAt.keys()] } },
      select: { ticketId: true, submittedAt: true },
    });
    const out = new Set<string>();
    for (const s of submissions) {
      const from = assignedAt.get(s.ticketId);
      if (from && s.submittedAt >= from) out.add(s.ticketId);
    }
    return out;
  }

  /**
   * Lifetime failure cycles per device — the chronic predicate's input, in one grouped query.
   *
   * This is the field that was hardcoded `null` at two sites beside a comment naming an
   * `attachFailureCycles` that never existed in the repo. Lifetime, with no window, because that is
   * what the surface promises in words: *"chronic device — n lifetime failure cycles"*. The windowed
   * 3-in-7-days rule is ADR-0021's **escalation** rule and stays where it is; see
   * `ticketing/chronic-device.ts` for why the two thresholds are separate constants.
   */
  private async failureCyclesByDevice(deviceIds: (string | null)[]): Promise<Map<string, number>> {
    const ids = [...new Set(deviceIds.filter((d): d is string => d != null))];
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.failureCycle.groupBy({
      by: ['deviceId'],
      where: { deviceId: { in: ids } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.deviceId, r._count._all]));
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
      // #363 — `id desc` after `windowStart desc`, the same tie-break `SeAvailabilityService` now uses.
      // Without it two windows sharing a start instant resolve arbitrarily and the FIRST-WINS loop
      // below can keep the row a manager has already corrected: the Cockpit strip would then show a
      // superseded status while the engineers page showed the correction. This read is a second copy
      // of `currentStatusMany`; it is not replaced by a call to it here because the two disagree at
      // the boundary (`gte` vs `gt` on `windowEnd`) and reconciling that is a change to what the
      // Cockpit shows, not a bug fix. Deduplicating them is filed as a follow-up.
      orderBy: [{ windowStart: 'desc' }, { id: 'desc' }],
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
  /**
   * Work today's runs could not place — **one row per ticket**, carrying the most recent verdict.
   *
   * The dedupe is the whole of this method's difficulty, and it was missing. A decision trace is
   * written **per run**, not per day, and a zone is dispatched more than once on any day somebody
   * presses Run Now or the recovery collector re-dispatches a crashed zone. A ticket nobody could take
   * at 05:00 and still nobody could take at 11:00 therefore has *two* `seId: null` traces, and this
   * read returned both.
   *
   * That was not a cosmetic duplicate. `rails.unassignable` is also what
   * `situation.unassignable` counts, so a second run inflated the headline figure on the one surface
   * whose purpose is to answer *what did not get placed* — a zone with 215 unplaceable tickets and two
   * runs reported 376. It also handed the client duplicate React keys, which is how it was found.
   *
   * **The latest trace wins**, because a ticket's current reason for being unassignable is what the
   * most recent run concluded, not what the first one did — coverage can be fixed and capacity can
   * free up between runs, and reporting the stale verdict would explain the wrong problem. Rows arrive
   * in `traceId` order (the order the engine processed them, which is the canonical sort), so a later
   * trace overwrites an earlier one while `Map` keeps the ticket at its **first** position — the
   * newest verdict, in processing order.
   */
  private async unassignableToday(zoneId: bigint, day: Date): Promise<TodayUnassignable[]> {
    const traces = await this.prisma.dispatchDecisionTrace.findMany({
      where: { zoneId, seId: null, run: { startedAt: { gte: day, lt: new Date(day.getTime() + 86_400_000) } } },
      orderBy: { traceId: 'asc' },
      include: { ticket: { select: { deviceId: true, plantId: true, plant: { select: { name: true } } } } },
    });
    const latestPerTicket = new Map<string, (typeof traces)[number]>();
    for (const t of traces) latestPerTicket.set(t.ticketId, t);
    return [...latestPerTicket.values()].map((t) => ({
      ticketId: t.ticketId,
      deviceId: t.ticket?.deviceId ?? null,
      plantId: t.ticket?.plantId != null ? String(t.ticket.plantId) : null,
      plantName: t.ticket?.plant?.name ?? null,
      poolEmptyReason: (t.trace as { poolEmptyReason?: string } | null)?.poolEmptyReason ?? null,
      // Filled in one grouped pass over both rails once this read resolves — see `today()`.
      failureCycles: null,
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
    const ids = tickets.map((t) => t.ticketId);
    const reports = await this.prisma.vehicleUnavailabilityReport.findMany({
      where: { ticketId: { in: ids }, status: 'OPEN' },
      select: { ticketId: true, expectedFrom: true, decidedBy: true },
    });
    const byTicket = new Map(reports.map((r) => [r.ticketId, r]));

    /**
     * **Who deferred it, and why** — a separate question from `decidedBy`, deliberately.
     *
     * `decidedBy` above answers only *who approved the vehicle-unavailability report*. A manager's own
     * `DEFER_TICKET` override creates no such report, so it left every field on this row null and the
     * rail drew a deliberate managerial decision exactly like a hold the system made. The operator who
     * deferred three devices read that as their decision not having been taken.
     *
     * Widening `decidedBy` to mean "or whoever deferred it" was the tempting one-line version and is
     * the wrong shape: one field standing for two different decisions is how a rail starts telling a
     * plausible lie about which of them happened. Two questions, two fields.
     *
     * Ordered newest-first and reduced to the first hit per ticket: a ticket may have been deferred
     * more than once across days, and the hold in force is the most recent one.
     */
    const defers = await this.prisma.batchAssignmentTicket.findMany({
      where: { ticketId: { in: ids }, removalReason: REMOVAL_REASONS.ZM_DEFERRED, removedBy: { not: null } },
      orderBy: { removedAt: 'desc' },
      select: { ticketId: true, removedBy: true, removalNote: true },
    });
    const deferByTicket = new Map<string, (typeof defers)[number]>();
    for (const d of defers) if (!deferByTicket.has(d.ticketId)) deferByTicket.set(d.ticketId, d);

    // One query for every name, not one per row. A name that does not resolve stays null and the
    // client renders the id — #284 B7's rule, never a fabricated name.
    const actorIds = [...new Set([...deferByTicket.values()].map((d) => d.removedBy!))];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({ where: { userId: { in: actorIds } }, select: { userId: true, name: true } })
      : [];
    const nameOf = new Map(actors.map((a) => [a.userId, a.name]));

    return tickets.map((t) => {
      const d = deferByTicket.get(t.ticketId);
      return {
        ticketId: t.ticketId,
        deviceId: t.deviceId,
        plantName: t.plant?.name ?? null,
        heldUntil: t.deferredUntil!.toISOString().slice(0, 10),
        failureCycles: null,
        expectedFrom: byTicket.get(t.ticketId)?.expectedFrom?.toISOString() ?? null,
        decidedBy: byTicket.get(t.ticketId)?.decidedBy ?? null,
        deferredBy: d?.removedBy ?? null,
        deferredByName: d ? (nameOf.get(d.removedBy!) ?? null) : null,
        deferredReason: d?.removalNote ?? null,
      };
    });
  }

  /**
   * Open escalations for the zone — every ticket a manager has been asked to decide about.
   *
   * Two causes now reach this list: CRITICAL work the engine refused to self-authorise an overload for
   * (#258 Q-B), and work stranded by an engineer going unavailable mid-day (#288). Each row carries
   * its `insertionType` and, when the ticket is still on somebody's live plan, who holds it — because
   * those two facts decide which action resolves the row, and a surface that cannot see them offers
   * the wrong one.
   */
  private async escalationsOpen(zoneId: bigint): Promise<TodayEscalation[]> {
    const rows = await this.prisma.intradayInsertion.findMany({
      where: { zoneId, status: 'ESCALATION_REQUIRED' },
      orderBy: { createdAt: 'desc' },
      select: { insertionId: true, ticketId: true, slaBucket: true, createdAt: true, insertionType: true },
    });
    const assignees = await currentAssigneesFor(
      this.prisma,
      rows.map((r) => r.ticketId),
    );
    return rows.map((r) => {
      const holder = assignees.get(r.ticketId) ?? null;
      return {
        insertionId: String(r.insertionId),
        ticketId: r.ticketId,
        slaBucket: r.slaBucket,
        createdAt: r.createdAt.toISOString(),
        insertionType: r.insertionType,
        assignedSeId: holder?.seId ?? null,
        assignedSeName: holder?.seName ?? null,
      };
    });
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

  /**
   * B1 — the two funnel populations that were recorded and never published.
   *
   * Read from the same `dispatch_run_zones` row `policyWithheldCount` reads, so all three describe the
   * same run of the same zone by construction. **No row, or a null column, returns null** — the caller
   * renders "not recorded", never `0`.
   */
  private async funnelTail(
    zoneId: bigint,
    day: Date,
  ): Promise<{ componentBlockedWithheld: number | null; bucketlessDropped: number | null }> {
    const row = await this.prisma.dispatchRunZone.findFirst({
      where: { zoneId, run: { startedAt: { gte: day, lt: new Date(day.getTime() + 86_400_000) } } },
      orderBy: { runId: 'desc' },
      select: { componentBlockedWithheld: true, bucketlessDropped: true },
    });
    return {
      componentBlockedWithheld: row?.componentBlockedWithheld ?? null,
      bucketlessDropped: row?.bucketlessDropped ?? null,
    };
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
