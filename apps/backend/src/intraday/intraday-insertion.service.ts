import { istDate } from '../common/ist-day';
import { notComponentBlocked } from '../ticketing/component-blocked';
import { notDeferredOn } from '../ticketing/deferral';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { SeAvailabilityService } from '../engineers/se-availability.service';
import { Prisma } from '../generated/prisma/client';
import { type SlaBucket } from '../generated/prisma/enums';
import { NotificationService } from '../notifications/notification.service';
import { InventoryService } from '../inventory/inventory.service';
import { buildCandidateReadiness } from '../recommender/candidate-readiness';
import { CandidateSelectionService } from '../recommender/candidate-selection.service';
import { urgencyFromBucket } from '../recommender/canonical-sort';
import { type LatLng, haversineKm } from '../recommender/distance';
import { applyHardFilters } from '../recommender/hard-filters';
import { plantCoordinatesForZone } from '../recommender/plant-geometry';
import { type ScoringFeatures, scoreCandidate } from '../recommender/scoring';
import {
  readBaseActiveWeights,
  readEngineerCapacity,
  readEngineerHomeBases,
  readPlantClusterMultiplier,
} from '../recommender/scoring-config';
import { chooseWithinTier } from '../recommender/tier-score-chooser';
import {
  ActorContext,
  type DeferralOverrideInput,
  type DeferralVuContext,
  OverrideService,
} from '../scheduling/override.service';
import { CandidateQueryService, type CandidateRow } from '../scheduling/candidate-query.service';
import { committedDayPlan } from '../scheduling/committed-day-load';
import { drainNotificationRows, queueNotification } from '../scheduling/day-plan-notification-outbox';
import { type CurrentAssignee, currentAssigneesFor } from './current-assignee';
import { ZmScope } from '../scheduling/zm-schedule-query.service';
import { PrismaService } from '../prisma/prisma.service';

/** SLA buckets that trigger a system intra-day insertion (CONTEXT §16). */
const TRIGGER_BUCKETS: SlaBucket[] = ['CRITICAL', 'HIGH_CRITICAL'];

/** The SYSTEM actor + scope every direct-assign / no-candidate escalation writes under (#268 Q3). */
const SYSTEM_ACTOR: ActorContext = { userId: 'SYSTEM', role: 'SYSTEM' };
const SYSTEM_SCOPE: ZmScope = { role: 'SYSTEM', zoneId: null };

export interface IntradayInsertionRow {
  insertionId: string;
  ticketId: string;
  zoneId: string;
  companyId: string;
  companyTier: string;
  insertionType: string;
  slaBucket: SlaBucket | null;
  /** #268 — null on an ESCALATION_REQUIRED row from Q-B's "no capacity-eligible SE" path. */
  offeredSeId: string | null;
  offeredAt: string;
  /** #268 — null for the same reason: no acceptance window applies to a direct-assign or escalation. */
  acceptanceDeadline: string | null;
  status: string;
  declineReasonCode: string | null;
  retryCount: number;
  whatsappSent: boolean;
  createdAt: string;
  /**
   * #288 — the engineer this ticket is live on right now, or null when it is on nobody's plan.
   *
   * Not the same question as `offeredSeId`, and the difference is the whole point: an escalation whose
   * ticket is **already assigned** cannot be resolved by the queue's Assign (`assignTicket` refuses an
   * assigned ticket), only by a reassign on that engineer's day plan. A surface that cannot tell the
   * two apart offers a button that 409s on exactly the rows it looks most needed on.
   */
  assignedSeId: string | null;
  assignedSeName: string | null;
}

export interface CriticalAssignOutcome {
  /** Tickets the sweep assigned directly this tick. */
  assigned: number;
  /** Tickets that escalated to the ZM this tick — no capacity-eligible SE existed. */
  escalated: number;
}

export type ManualAssignOutcome =
  | { result: 'OK'; insertionId: string; scheduleId: string; batchId: string; seId: string }
  | { result: 'NOT_FOUND' }
  | { result: 'ALREADY_ASSIGNED' }
  /**
   * #265 / #249 — the ticket is held to a future return date. Previously collapsed into `NOT_FOUND`,
   * which the controller renders as a 404: a resolvable, actionable condition reported to the ZM as
   * "that doesn't exist", so they retry, get the same 404, and the retry chain burns against a hold
   * nothing on screen names. A deferral may be **overridden, never bypassed** — and a ZM told "not
   * found" cannot override anything.
   */
  | { result: 'CONFLICT_DEFERRED'; ticketId: string; deferredUntil: string; vuReport: DeferralVuContext | null }
  /** #249 — confirmed, but with no reason. An override with no stated why is not an override. */
  | { result: 'REASON_REQUIRED' };

type ActiveInsertionTicket = Prisma.TicketGetPayload<{
  include: {
    device: { select: { state: { select: { slaBucket: true; latestGpsDatetime: true } } } };
    company: { select: { companyPriorityRank: true } };
  };
}>;

function toRow(
  r: Prisma.IntradayInsertionGetPayload<{ include: { ticket: { select: { companyId: true; companyTier: true } } } }>,
  assignee: CurrentAssignee | null = null,
): IntradayInsertionRow {
  return {
    insertionId: String(r.insertionId),
    ticketId: r.ticketId,
    zoneId: String(r.zoneId),
    companyId: String(r.ticket.companyId),
    companyTier: r.ticket.companyTier,
    insertionType: r.insertionType,
    slaBucket: r.slaBucket,
    offeredSeId: r.offeredSeId,
    offeredAt: r.offeredAt.toISOString(),
    acceptanceDeadline: r.acceptanceDeadline?.toISOString() ?? null,
    status: r.status,
    declineReasonCode: r.declineReasonCode,
    retryCount: r.retryCount,
    whatsappSent: r.whatsappSentAt !== null,
    createdAt: r.createdAt.toISOString(),
    assignedSeId: assignee?.seId ?? null,
    assignedSeName: assignee?.seName ?? null,
  };
}

/**
 * The system-triggered intra-day CRITICAL/HIGH_CRITICAL engine (CONTEXT §16, Issues 29/30 — #268
 * retired their SE Acceptance step per #258 Q3). `assignCriticalForZone` assigns each newly-CRITICAL
 * unassigned ticket **directly** to the best eligible SE — hard eligibility (availability, capacity as
 * an automatic constraint, Q2) → coverage tier → score, the identical discipline `RecommenderService`
 * uses via the shared {@link chooseWithinTier} — and lands it at the top of that SE's Day Plan. No
 * offer, no timeout, no SE veto. A ticket with no capacity-eligible candidate escalates to the ZM
 * (Q-B) rather than being assigned to an over-capacity SE; there is no automatic capacity bypass, ever.
 *
 * `intraday_insertions` remains the ledger: `ASSIGNED_DIRECT` for a system assignment, `ESCALATION_REQUIRED`
 * for a no-candidate escalation (spelled exactly as before the offer machinery existed — its MEANING
 * narrows from "3 SEs declined or timed out" to "no capacity-eligible SE exists", not its spelling —
 * `system-efficiency-aggregation.service.ts` counts this status into the daily `auto_escalations` cube
 * and a rename would silently zero a live report).
 *
 * `manualAssign` and `availableSesForManualAssign` are unchanged: the ZM's escalation-queue resolution
 * is a human decision and Q2's administrative right to exceed capacity is preserved exactly as before.
 */
@Injectable()
export class IntradayInsertionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly candidates: CandidateSelectionService,
    private readonly override: OverrideService,
    private readonly notifications: NotificationService,
    private readonly availability: SeAvailabilityService = new SeAvailabilityService(prisma),
    private readonly audit: AuditService = new AuditService(prisma),
    /** #277 — `available-ses`' row shape, published from #274's own assembly rather than re-spelled here. */
    private readonly candidateQuery: CandidateQueryService = new CandidateQueryService(
      prisma,
      candidates,
      availability,
      new InventoryService(prisma),
    ),
  ) {}

  /**
   * One zone, one tick: every OPEN+UNASSIGNED CRITICAL/HIGH_CRITICAL ticket is either assigned directly
   * or escalated. `intradayInsertions: { none: { status: 'ESCALATION_REQUIRED' } }` is the reason an
   * escalated ticket does not re-escalate (and re-alert the ZM) every 2 minutes: it stays UNASSIGNED
   * until a human's `manualAssign` moves it, and a live ESCALATION_REQUIRED row is that ticket's "a
   * human already knows" marker. An `ASSIGNED_DIRECT` ticket needs no equivalent exclusion — it is no
   * longer UNASSIGNED, so the base query already drops it.
   */
  async assignCriticalForZone(zoneId: bigint, now: Date = new Date()): Promise<CriticalAssignOutcome> {
    const tickets = await this.prisma.ticket.findMany({
      where: {
        status: 'OPEN',
        assignmentState: 'UNASSIGNED',
        // #146 — a ZM-deferred ticket must never be system-assigned on the very day it was deferred off
        // the plan (AC pin: "a deferred CRITICAL ticket is never system-assigned").
        ...notDeferredOn(istDate(now)),
        plant: { zoneId },
        device: { state: { slaBucket: { in: TRIGGER_BUCKETS } } },
        intradayInsertions: { none: { status: 'ESCALATION_REQUIRED' } },
        // #177 — the same exclusion the morning pool takes, reached by a different query. A
        // component-blocked ticket direct-assigned within minutes is a wasted trip for a job whose
        // part is still on order — strictly worse than today's manual-only path.
        AND: [notComponentBlocked()],
      },
      include: {
        device: { select: { state: { select: { slaBucket: true, latestGpsDatetime: true } } } },
        company: { select: { companyPriorityRank: true } },
      },
    });
    if (tickets.length === 0) return { assigned: 0, escalated: 0 };

    // #268 — CRITICAL/HIGH_CRITICAL is active-emergency work, never backlog, so this reads only the
    // base/DEFICIT weight set: PREVENTIVE's repeat-failure-bonus / aged-device bias exists to redirect
    // attention toward backlog when a zone is *healthy*, which would be a live contradiction on a
    // ticket this sweep exists to move fast. See `scoring-config.ts`'s docstring.
    const { weights } = await readBaseActiveWeights(this.prisma);
    const clusterMultiplier = await readPlantClusterMultiplier(this.prisma);
    const capacity = await readEngineerCapacity(this.prisma);

    // #266 Q-A's seed, reused verbatim: one read gives both the in-tick capacity counter AND each SE's
    // plants-today set, so capacity and clustering can never disagree about which stops count. Grown
    // in-loop exactly like the morning batch's `assigned`/`plantsBySe`, so a second CRITICAL ticket in
    // this same tick sees the first ticket's assignment before it is scored.
    const day = istDate(now);
    const committed = await committedDayPlan(this.prisma, day);
    const committedCount = new Map<string, number>();
    const plantsBySe = new Map<string, Set<string>>();
    const lastStopPlantBySe = new Map<string, string | null>();
    for (const [seId, entry] of committed) {
      committedCount.set(seId, entry.count);
      plantsBySe.set(seId, entry.plants);
      lastStopPlantBySe.set(seId, entry.lastStopPlantId);
    }

    // #267 — the same distance seam the morning batch closes, wired identically ("same discipline")
    // rather than left permanently NOT_AVAILABLE on the CRITICAL path. Plant geometry is zone-scoped
    // and fetched once per tick (this sweep's own "per zone-run" boundary); home bases are global.
    const plantCoords = await plantCoordinatesForZone(this.prisma, zoneId);
    const homeBases = await readEngineerHomeBases(this.prisma);
    const currentPos = new Map<string, LatLng | null>();
    const currentPosFor = (seId: string): LatLng | null => {
      if (!currentPos.has(seId)) {
        const lastStopPlant = lastStopPlantBySe.get(seId);
        const seeded = (lastStopPlant && plantCoords.get(lastStopPlant)) || homeBases.get(seId) || null;
        currentPos.set(seId, seeded);
      }
      return currentPos.get(seId)!;
    };
    const distanceKmFor = (seId: string, plantId: string): number | null => {
      const pos = currentPosFor(seId);
      const dest = plantCoords.get(plantId);
      if (pos === null || dest === undefined) return null;
      return haversineKm(pos, dest);
    };

    let assigned = 0;
    let escalated = 0;
    for (const ticket of tickets) {
      const ordered = await this.candidates.orderedCandidatesForPlant(ticket.plantId);
      const availabilityBySe = await this.availability.currentStatusMany(
        ordered.map((c) => c.seId),
        now,
      );

      const readiness = ordered.map((c) =>
        buildCandidateReadiness({
          seId: c.seId,
          coverageType: c.coverageType,
          availabilityStatus: availabilityBySe.get(c.seId) ?? 'AVAILABLE',
          committed: committedCount.get(c.seId) ?? 0,
          capacity: capacity.get(c.seId),
          // #268's scope: Common Kit gates the morning batch's readiness; the intraday path has never
          // consulted van stock (its offer engine's `availableCandidates` didn't either), and adding a
          // new hard-filter dimension is not something this issue asked for. Trusted `true` matches
          // the morning batch's own default for an unbuilt seam, not a lowered bar.
          commonKitComplete: true,
        }),
      );
      const { passed } = applyHardFilters(readiness);

      const ticketPlant = String(ticket.plantId);
      const clusterFor = (seId: string): number => (plantsBySe.get(seId)?.has(ticketPlant) ? clusterMultiplier : 1);
      // #267 — per-candidate, like the morning batch: every candidate for this ticket shares the same
      // base, so `distanceFromPrevStopKm` (route position → this plant) is the only term that can
      // separate them.
      const featuresFor = (seId: string): ScoringFeatures => ({
        companyPriorityRank: ticket.company.companyPriorityRank,
        dispatchUrgency: urgencyFromBucket(ticket.device.state!.slaBucket!),
        repeatFailure: ticket.repeatFailure,
        inactivityHours: ticket.device.state!.latestGpsDatetime
          ? Math.max(0, (now.getTime() - ticket.device.state!.latestGpsDatetime.getTime()) / 3_600_000)
          : null,
        distanceFromPrevStopKm: distanceKmFor(seId, ticketPlant),
      });

      // #268 — no SE Planner pin: the ADR-0022 soft bias is a morning-batch concept the issue's ACs
      // never extend to CRITICAL work, so this stays pure tier+score rather than inventing a new rule.
      const { chosen } = chooseWithinTier({
        passed,
        scoreFor: (c) => scoreCandidate(featuresFor(c.seId), weights, clusterFor(c.seId)).score,
      });

      if (chosen === null) {
        await this.escalate(ticket, zoneId, now);
        escalated++;
        continue;
      }

      // #338 — the rows the hook below enqueues, for the post-commit delivery attempt. Cleared at the
      // top of every hook run because `assignTicket` re-runs it on a `WorkSchedule` race: the losing
      // attempt's row rolled back with it and must not be drained for.
      const queuedNotices: bigint[] = [];
      const result = await this.override.assignTicket(
        ticket.ticketId,
        chosen.seId,
        SYSTEM_SCOPE,
        SYSTEM_ACTOR,
        now,
        'CRITICAL_ASSIGN',
        true,
        {},
        // #283 — this path already knows the tier it selected within: `chosen` came out of
        // `chooseWithinTier` over `orderedCandidatesForPlant`. Passing it records the tier the engine
        // actually evaluated, rather than one re-derived from `se_coverage` a moment later.
        chosen.coverageType,
        // #325 (RC-9) — the ledger row is the record that this assignment happened at all: the
        // Intra-day Queue reads nothing else, and the efficiency cube counts these rows. Written here,
        // inside the assignment's own transaction, it can no longer be the thing that was lost when
        // the process died a moment after the commit — an assigned CRITICAL ticket that, to every
        // reader of the queue, was never assigned by anybody.
        async (tx, ids) => {
          queuedNotices.length = 0;
          await tx.intradayInsertion.create({
            data: {
              ticketId: ticket.ticketId,
              zoneId,
              insertionType: 'SYSTEM_CRITICAL',
              slaBucket: ticket.device.state?.slaBucket ?? null,
              offeredSeId: chosen.seId,
              offeredAt: now,
              acceptanceDeadline: now,
              respondedAt: now,
              status: 'ASSIGNED_DIRECT',
              assignedScheduleId: ids.scheduleId,
              assignedBatchId: ids.batchId,
            },
          });
          // #338 — the SE's notice, written in the same transaction as the assignment it announces.
          // Same payload as the post-commit `notify()` this replaces (the ids are stringified here
          // because they were already strings on the `AssignOutcome` this used to read them from —
          // and because a `bigint` cannot go into a JSON column).
          queuedNotices.push(
            await queueNotification(tx, {
              recipients: [{ userId: chosen.seId, role: 'SERVICE_ENGINEER' }],
              type: 'INTRADAY_DIRECT_ASSIGNED',
              title: 'CRITICAL ticket added to your Day Plan',
              body: `Ticket ${ticket.ticketId} was assigned to you and added at the top of your Day Plan.`,
              entityType: 'ticket',
              entityId: ticket.ticketId,
              deliveryModel: 'GENERAL',
              metadata: {
                ticketId: ticket.ticketId,
                scheduleId: String(ids.scheduleId),
                batchId: String(ids.batchId),
              },
            }),
          );
        },
      );
      // Not OK: a concurrent writer (a ZM's manual assign, a second sweep instance) already moved this
      // ticket, or the deferral check inside `assignTicket` disagreed with the query above by a
      // clock/TZ edge. Either way nothing for THIS call to do — no insertion row, no counter, no retry.
      if (result.result !== 'OK') continue;

      committedCount.set(chosen.seId, (committedCount.get(chosen.seId) ?? 0) + 1);
      const plants = plantsBySe.get(chosen.seId) ?? new Set<string>();
      plants.add(ticketPlant);
      plantsBySe.set(chosen.seId, plants);
      // #267 — advance the winner's route position, same as the morning batch (§ above).
      const wonCoord = plantCoords.get(ticketPlant);
      if (wonCoord) currentPos.set(chosen.seId, wonCoord);

      // The DELIVERY stays out of the transaction, for the reason this comment has always given: an
      // SE told their Day Plan changed for a change that then rolled back is worse than a late push,
      // and there is no un-sending it. What moved (#338) is the *intent*, which is now a committed
      // row — so a push that fails here is retried by the sweep instead of lost, and can no longer
      // abandon the rest of this zone's CRITICAL tickets by throwing out of the loop.
      await drainNotificationRows(this.prisma, this.notifications, queuedNotices, now);
      assigned++;
    }
    return { assigned, escalated };
  }

  /** Every active zone, one tick — the sweep's actual entry point (#268 item 3, the renamed cron). */
  async assignCriticalForActiveZones(now: Date = new Date()): Promise<CriticalAssignOutcome> {
    // Mirrors `DispatchRunService.activeZoneIds` — a zone with no plants can carry no CRITICAL work,
    // so it is excluded rather than iterated for nothing.
    const zones = await this.prisma.plant.findMany({ distinct: ['zoneId'], select: { zoneId: true }, orderBy: { zoneId: 'asc' } });
    let assigned = 0;
    let escalated = 0;
    for (const { zoneId } of zones) {
      const r = await this.assignCriticalForZone(zoneId, now);
      assigned += r.assigned;
      escalated += r.escalated;
    }
    return { assigned, escalated };
  }

  /**
   * Write the escalation ledger row + alert the ZM. `offeredSeId`/`acceptanceDeadline` are null
   * (#268): no SE was ever offered anything.
   *
   * #338 — the row and the alert are now one transaction. They were two bare awaits, which is the
   * absence NOTIF-02 named: a crash between them left an `ESCALATION_REQUIRED` row that nobody had
   * been told about, indistinguishable on the Intra-day Queue from one a manager has already seen and
   * is deciding on. Unlike the two assign doors above, this path had no transaction to enqueue into —
   * so it gets one here, rather than the weaker "enqueue on `this.prisma`" the sites blocked on #354
   * are stuck with.
   */
  private async escalate(ticket: ActiveInsertionTicket, zoneId: bigint, now: Date): Promise<void> {
    const outboxId = await this.prisma.$transaction(async (tx) => {
      const ins = await tx.intradayInsertion.create({
        data: {
          ticketId: ticket.ticketId,
          zoneId,
          insertionType: 'SYSTEM_CRITICAL',
          slaBucket: ticket.device.state?.slaBucket ?? null,
          offeredSeId: null,
          offeredAt: now,
          acceptanceDeadline: null,
          respondedAt: now,
          status: 'ESCALATION_REQUIRED',
        },
      });
      return this.escalateToZm(tx, zoneId, ticket.ticketId, ins.insertionId);
    });
    await drainNotificationRows(this.prisma, this.notifications, outboxId === null ? [] : [outboxId], now);
  }

  /**
   * Available candidate SEs for the ZM manual-assignment modal (Issue 30, row shape by #277) —
   * `AVAILABLE` only, no ping filter. Returns #274's candidate row (name, coverage, load, kit) instead
   * of a bare `string[]` — the modal this feeds had no admin client before #277 precisely because a
   * list of UUIDs cannot be shown to a human. The **set** of SEs offered is unchanged from before #277:
   * filtered on `availabilityStatus`, exactly as the old `availableCandidates` did, not on the hard-filter
   * `verdict` `CandidateQueryService` also carries — a capacity- or kit-short SE was always offered here
   * (Q2: an administrative override, not a gate), and folding the verdict in would silently narrow the set.
   */
  async availableSesForManualAssign(insertionId: bigint, scope: ZmScope, now: Date = new Date()): Promise<CandidateRow[]> {
    const ins = await this.prisma.intradayInsertion.findUnique({
      where: { insertionId },
      include: { ticket: { select: { plantId: true } } },
    });
    if (!ins) return [];
    const view = await this.candidateQuery.listForPlants([ins.ticket.plantId], scope, now);
    const plant = view.plants[0];
    if (!plant) return [];
    return plant.candidates.filter((c) => c.availabilityStatus === 'AVAILABLE');
  }

  /** ZM manual assignment from the escalation queue — commits to the chosen SE (no SE Acceptance gate). */
  async manualAssign(
    insertionId: bigint,
    seId: string,
    actor: ActorContext,
    scope: ZmScope,
    now: Date = new Date(),
    /**
     * #265 item 4 — the ZM's explicit decision about a return-date deferral, passed through to
     * `assignTicket` rather than left to default. Without it this path could only ever *hit* the
     * deferral, never resolve it, so #249's confirm flow was unreachable from the escalation queue.
     */
    deferral: DeferralOverrideInput = {},
  ): Promise<ManualAssignOutcome> {
    const ins = await this.prisma.intradayInsertion.findUnique({ where: { insertionId } });
    if (!ins) return { result: 'NOT_FOUND' };
    // #338 — see the direct-assign door above; the hook clears this on every run for the same reason.
    const queuedNotices: bigint[] = [];
    const assigned = await this.override.assignTicket(
      ins.ticketId,
      seId,
      scope,
      actor,
      now,
      'CRITICAL_ASSIGN',
      true,
      deferral,
      null,
      // #325 (RC-9), re-scoped after #298. #298 already closes an `ESCALATION_REQUIRED` row inside
      // this transaction, so the status alone survived a crash here — but it closed it without the
      // ids, and an ACCEPTED row that cannot name the schedule or batch the work went onto is a
      // ledger entry that does not describe an assignment. This is that stamp, in the same
      // transaction; it runs after #298's guarded `updateMany` and is unconditional on `insertionId`,
      // which is the pre-#325 behaviour unchanged — this door owns the response for its own row.
      async (tx, ids) => {
        queuedNotices.length = 0;
        await tx.intradayInsertion.update({
          where: { insertionId },
          data: {
            status: 'ACCEPTED',
            offeredSeId: seId,
            respondedAt: now,
            assignedScheduleId: ids.scheduleId,
            assignedBatchId: ids.batchId,
          },
        });
        // #338 — the SE's notice, in the same transaction as the assignment. Payload unchanged from
        // the post-commit `notify()` this replaces.
        queuedNotices.push(
          await queueNotification(tx, {
            recipients: [{ userId: seId, role: 'SERVICE_ENGINEER' }],
            type: 'INTRADAY_MANUAL_ASSIGNED',
            title: 'CRITICAL insertion assigned to you',
            body: `Ticket ${ins.ticketId} added to your Day Plan by your manager.`,
            entityType: 'ticket',
            entityId: ins.ticketId,
            metadata: { insertionId: String(insertionId), ticketId: ins.ticketId },
          }),
        );
      },
    );
    if (assigned.result === 'ALREADY_ASSIGNED') return { result: 'ALREADY_ASSIGNED' };
    // #265 — carried through verbatim instead of flattened. `NOT_FOUND` stays what it always meant:
    // the insertion, ticket or SE genuinely is not there.
    if (assigned.result === 'CONFLICT_DEFERRED') return assigned;
    if (assigned.result === 'REASON_REQUIRED') return { result: 'REASON_REQUIRED' };
    if (assigned.result !== 'OK') return { result: 'NOT_FOUND' };

    // Delivered post-commit, for the same reason as the direct-assign path above — off a row that is
    // already durable (#338).
    await drainNotificationRows(this.prisma, this.notifications, queuedNotices, now);
    return { result: 'OK', insertionId: String(insertionId), scheduleId: assigned.scheduleId, batchId: assigned.batchId, seId };
  }

  /** The Intra-day Queue read (zone-scoped for ZM; cross-zone for CSM/OH). */
  async listForScope(scope: { role: string; zoneId: number | null }): Promise<IntradayInsertionRow[]> {
    const where: Prisma.IntradayInsertionWhereInput =
      scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? { zoneId: BigInt(scope.zoneId) } : {};
    const rows = await this.prisma.intradayInsertion.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { ticket: { select: { companyId: true, companyTier: true } } },
    });
    // #288 — one query for the whole page rather than one per row; absent means "on nobody's plan".
    const assignees = await currentAssigneesFor(
      this.prisma,
      rows.map((r) => r.ticketId),
    );
    return rows.map((r) => toRow(r, assignees.get(r.ticketId) ?? null));
  }

  /**
   * Queue the zone's ZM "Manual assignment needed" Action-Required alert (Issue 30) inside the
   * caller's transaction (#338). Returns the outbox row id for the caller's post-commit drain, or
   * null when the zone has no ZM — unchanged behaviour, there is simply nobody to tell.
   *
   * The zone is read on `tx` rather than `this.prisma` so the recipient the row records is the one
   * this transaction saw, not one a re-read at delivery time might disagree with.
   */
  private async escalateToZm(
    tx: Prisma.TransactionClient,
    zoneId: bigint,
    ticketId: string,
    insertionId: bigint,
  ): Promise<bigint | null> {
    const zone = await tx.zone.findUnique({ where: { zoneId } });
    if (!zone?.zonalManagerUserId) return null;
    return queueNotification(tx, {
      recipients: [{ userId: zone.zonalManagerUserId, role: 'ZONAL_MANAGER' }],
      type: 'INTRADAY_ESCALATION_REQUIRED',
      title: 'Manual assignment needed',
      body: `CRITICAL ticket ${ticketId} could not be auto-assigned — no capacity-eligible engineer.`,
      entityType: 'ticket',
      entityId: ticketId,
      deliveryModel: 'GENERAL',
      metadata: { insertionId: String(insertionId), ticketId },
    });
  }
}
