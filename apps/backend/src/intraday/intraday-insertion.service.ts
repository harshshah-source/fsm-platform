import { istDate } from '../common/ist-day';
import { notComponentBlocked } from '../ticketing/component-blocked';
import { notDeferredOn } from '../ticketing/deferral';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { transitionOrConflict } from '../common/transition-or-conflict';
import { SeAvailabilityService } from '../engineers/se-availability.service';
import { Prisma } from '../generated/prisma/client';
import { type SlaBucket } from '../generated/prisma/enums';
import { NotificationService } from '../notifications/notification.service';
import { CandidateSelectionService } from '../recommender/candidate-selection.service';
import {
  ActorContext,
  type DeferralOverrideInput,
  type DeferralVuContext,
  OverrideService,
} from '../scheduling/override.service';
import { ZmScope } from '../scheduling/zm-schedule-query.service';
import { PrismaService } from '../prisma/prisma.service';

/** CONTEXT §16 — the bounded interval for the offered SE to accept an intra-day insertion. */
export const ACCEPTANCE_TIMEOUT_MIN = 10;
/** CONTEXT §16 — after this many unsuccessful reroutes the insertion escalates to the ZM. */
export const MAX_RETRIES = 3;
/** Decline reason codes (Issue 29). */
export const DECLINE_REASON_CODES = ['AT_CAPACITY', 'TRAVEL_TOO_FAR', 'VEHICLE_TROUBLE', 'OTHER'] as const;
export type DeclineReasonCode = (typeof DECLINE_REASON_CODES)[number];

/** SLA buckets that trigger a system intra-day insertion (CONTEXT §16). */
const TRIGGER_BUCKETS: SlaBucket[] = ['CRITICAL', 'HIGH_CRITICAL'];

export interface RetryAttempt {
  seId: string;
  offeredAt: string;
  outcome: 'TIMED_OUT' | 'DECLINED';
  reasonCode?: string | null;
  at: string;
}

export interface IntradayInsertionRow {
  insertionId: string;
  ticketId: string;
  zoneId: string;
  companyId: string;
  companyTier: string;
  insertionType: string;
  slaBucket: SlaBucket | null;
  offeredSeId: string;
  offeredAt: string;
  acceptanceDeadline: string;
  status: string;
  declineReasonCode: string | null;
  retryCount: number;
  retryChain: RetryAttempt[];
  whatsappSent: boolean;
  createdAt: string;
}

export type AcceptOutcome =
  | { result: 'OK'; insertionId: string; scheduleId: string; batchId: string; ticketId: string; seId: string }
  | { result: 'NOT_FOUND' }
  | { result: 'NOT_PENDING'; status: string }
  | { result: 'NOT_OFFERED' };

export type DeclineOutcome =
  | { result: 'OK'; status: 'PENDING_ACCEPTANCE' | 'ESCALATION_REQUIRED'; nextSeId: string | null }
  | { result: 'INVALID_REASON' }
  | { result: 'NOT_FOUND' }
  | { result: 'NOT_PENDING'; status: string }
  | { result: 'NOT_OFFERED' };

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

type ActiveInsertionTicket = Prisma.TicketGetPayload<{ include: { device: { select: { state: true } } } }>;

/**
 * The system-triggered intra-day CRITICAL/HIGH_CRITICAL insertion + SE Acceptance engine (CONTEXT §16,
 * Issues 29/30). `fireForZone` offers each newly-CRITICAL unassigned ticket to the best available
 * candidate (strict coverage precedence) and pushes an in-app Accept/Decline. `accept` commits the
 * Formal Assignment at the top of the Day Plan and sends the first-class WhatsApp Confirmation; `decline`
 * (mandatory reason) and the 10-min `sweepTimeouts` both reroute to the next-best SE, accumulating the
 * `retryChain`; after 3 unsuccessful reroutes the insertion escalates to the ZM for manual assignment.
 *
 * Activity-ping staleness is never a candidate filter — only `SE_AVAILABILITY.status = AVAILABLE` gates a
 * candidate; an offline SE simply never taps Accept and the timeout reroutes (CONTEXT §3/§16).
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
  ) {}

  /**
   * Qualifying Event sweep: offer every OPEN, UNASSIGNED, CRITICAL/HIGH_CRITICAL ticket in the zone that
   * has no live insertion to its best available candidate. Tickets with no available candidate are left
   * for the ZM Grouped Critical Queue (Issue 13) — not silently dropped.
   */
  async fireForZone(zoneId: bigint, now: Date = new Date()): Promise<{ offered: number; skipped: number }> {
    const tickets = await this.prisma.ticket.findMany({
      where: {
        status: 'OPEN',
        assignmentState: 'UNASSIGNED',
        // #146 — a ZM-deferred ticket must not be offered back to an SE as an intraday CRITICAL
        // insertion on the very day it was deferred off the plan.
        ...notDeferredOn(istDate(now)),
        plant: { zoneId },
        device: { state: { slaBucket: { in: TRIGGER_BUCKETS } } },
        intradayInsertions: { none: { status: { in: ['PENDING_ACCEPTANCE', 'ACCEPTED'] } } },
        // #177 — the same exclusion the morning pool takes, reached by a different query. Speed is
        // this sweep's whole point, which is exactly what makes a component-blocked ticket worse here
        // than there: the offer lands on the SE's phone within minutes for a job whose part is still
        // on order, and the fastest possible Accept is a wasted trip. Nested under `AND` because both
        // this predicate and `notDeferredOn` above are top-level `OR`s — see the predicate's docblock.
        AND: [notComponentBlocked()],
      },
      include: { device: { select: { state: true } } },
    });

    let offered = 0;
    let skipped = 0;
    for (const ticket of tickets) {
      const candidate = (await this.availableCandidates(ticket.plantId, now))[0];
      if (!candidate) {
        skipped++;
        continue;
      }
      try {
        await this.offer(ticket, candidate, zoneId, now);
        offered++;
      } catch (e) {
        // One-live-offer-per-ticket partial unique (Issue 101): a concurrent sweep already opened the
        // live offer for this ticket — a clean skip, not a duplicate PENDING row.
        if ((e as { code?: string }).code === 'P2002') {
          skipped++;
          continue;
        }
        throw e;
      }
    }
    return { offered, skipped };
  }

  /** SE one-tap Accept — commits the Formal Assignment at the top of the Day Plan + first-class WhatsApp. */
  async accept(insertionId: bigint, seId: string, now: Date = new Date()): Promise<AcceptOutcome> {
    const ins = await this.prisma.intradayInsertion.findUnique({ where: { insertionId } });
    if (!ins) return { result: 'NOT_FOUND' };
    // Idempotent: a retried Accept on an insertion this SE already accepted succeeds with the same row.
    if (ins.status === 'ACCEPTED' && ins.offeredSeId === seId) {
      return {
        result: 'OK',
        insertionId: String(ins.insertionId),
        scheduleId: String(ins.assignedScheduleId),
        batchId: String(ins.assignedBatchId),
        ticketId: ins.ticketId,
        seId,
      };
    }
    if (ins.status !== 'PENDING_ACCEPTANCE') return { result: 'NOT_PENDING', status: ins.status };
    if (ins.offeredSeId !== seId) return { result: 'NOT_OFFERED' };

    // Atomic claim (Issue 101): flip PENDING_ACCEPTANCE → ACCEPTED guarded by our own offer. This is the
    // serialization point against a concurrent 10-min timeout / decline reroute — exactly one of
    // {accept, reroute} updates the row, the other sees 0 rows. Without it both can "win", committing the
    // ticket to a timed-out SE A while SE B holds a live offer (both told the CRITICAL ticket is theirs).
    const claim = await transitionOrConflict(
      this.prisma.intradayInsertion,
      { insertionId, status: 'PENDING_ACCEPTANCE', offeredSeId: seId },
      { status: 'ACCEPTED', respondedAt: now, whatsappSentAt: now },
    );
    if (!claim.won) {
      // Lost the race to a concurrent reroute/accept. Re-read to answer accurately (idempotent if the
      // winner was this same SE via a retried tap).
      const fresh = await this.prisma.intradayInsertion.findUnique({ where: { insertionId } });
      if (fresh?.status === 'ACCEPTED' && fresh.offeredSeId === seId) {
        return {
          result: 'OK',
          insertionId: String(fresh.insertionId),
          scheduleId: String(fresh.assignedScheduleId),
          batchId: String(fresh.assignedBatchId),
          ticketId: fresh.ticketId,
          seId,
        };
      }
      return { result: 'NOT_PENDING', status: fresh?.status ?? ins.status };
    }

    // We own the insertion. Commit the Formal Assignment at the top of the Day Plan.
    const ticket = await this.prisma.ticket.findUniqueOrThrow({
      where: { ticketId: ins.ticketId },
      include: { plant: true },
    });
    const scope: ZmScope = { role: 'SERVICE_ENGINEER', zoneId: Number(ticket.plant.zoneId) };
    const actor: ActorContext = { userId: seId, role: 'SERVICE_ENGINEER' };
    const assigned = await this.override.assignTicket(ins.ticketId, seId, scope, actor, now, 'CRITICAL_ASSIGN', true);
    if (assigned.result !== 'OK') {
      // #265 item 4 — a deferral is not a re-offerable failure. Every other reason to land here means
      // "somebody else took it", where releasing the claim so the timeout sweep re-offers is exactly
      // right. A `CONFLICT_DEFERRED` is different in kind: **no Service Engineer can clear a hold.**
      // Re-offering hands the identical refusal to the next SE, and the next, until the retry chain is
      // exhausted and the ticket escalates anyway — hours later, with a trail recording several SEs
      // declining nothing. A hold only a manager may override goes to a manager now; #265 gave the
      // escalation queue's manual assign the `CONFLICT_DEFERRED` answer and the confirm-with-reason
      // flow to resolve it, so this hands the ZM something actionable rather than another dead end.
      if (assigned.result === 'CONFLICT_DEFERRED') {
        const claim = await transitionOrConflict(
          this.prisma.intradayInsertion,
          { insertionId, status: 'ACCEPTED', offeredSeId: seId },
          { status: 'ESCALATION_REQUIRED', respondedAt: now },
        );
        // Guarded like the release below: a writer that already moved the insertion on is untouched,
        // and the escalation side effect fires only if this call actually owns the transition.
        if (claim.won) await this.escalateToZm(ins.zoneId, ins.ticketId, ins.insertionId);
        return { result: 'NOT_PENDING', status: 'ESCALATION_REQUIRED' };
      }
      // Ticket was closed/assigned out between our claim and this commit. Release the claim (guarded, so a
      // writer that already moved it on again is untouched) so the timeout sweep can re-offer it.
      await transitionOrConflict(
        this.prisma.intradayInsertion,
        { insertionId, status: 'ACCEPTED', offeredSeId: seId },
        { status: 'PENDING_ACCEPTANCE', respondedAt: null, whatsappSentAt: null },
      );
      return { result: 'NOT_PENDING', status: ins.status };
    }

    await this.prisma.intradayInsertion.update({
      where: { insertionId },
      data: {
        assignedScheduleId: BigInt(assigned.scheduleId),
        assignedBatchId: BigInt(assigned.batchId),
      },
    });

    await this.notifications.notify({
      recipients: [{ userId: seId, role: 'SERVICE_ENGINEER' }],
      type: 'INTRADAY_ACCEPTED_CONFIRMATION',
      title: 'CRITICAL insertion confirmed',
      body: `Ticket ${ins.ticketId} added to your Day Plan.`,
      entityType: 'ticket',
      entityId: ins.ticketId,
      deliveryModel: 'SE_ACCEPTANCE',
      metadata: {
        insertionId: String(insertionId),
        ticketId: ins.ticketId,
        vehicleId: ticket.vehicleId != null ? String(ticket.vehicleId) : null,
        plantId: String(ticket.plantId),
        deeplink: `fsm://tickets/${ins.ticketId}`,
      },
    });

    await this.audit.withAudit(
      {
        actorId: seId,
        actorRole: 'SERVICE_ENGINEER',
        action: 'INTRADAY_ACCEPT',
        entityType: 'intraday_insertion',
        entityId: String(insertionId),
        metadata: { ticketId: ins.ticketId, seId },
      },
      async (tx) => {
        await tx.ticketEvent.create({
          data: { ticketId: ins.ticketId, toState: 'CRITICAL_INSERTION_ACCEPTED', actorId: seId, actorRole: 'SERVICE_ENGINEER' },
        });
      },
    );

    return {
      result: 'OK',
      insertionId: String(insertionId),
      scheduleId: assigned.scheduleId,
      batchId: assigned.batchId,
      ticketId: ins.ticketId,
      seId,
    };
  }

  /** SE Decline with a mandatory reason code → reroute to the next-best SE (or escalate). */
  async decline(insertionId: bigint, seId: string, reasonCode: string, now: Date = new Date()): Promise<DeclineOutcome> {
    if (!DECLINE_REASON_CODES.includes(reasonCode as DeclineReasonCode)) return { result: 'INVALID_REASON' };
    const ins = await this.prisma.intradayInsertion.findUnique({ where: { insertionId } });
    if (!ins) return { result: 'NOT_FOUND' };
    if (ins.status !== 'PENDING_ACCEPTANCE') return { result: 'NOT_PENDING', status: ins.status };
    if (ins.offeredSeId !== seId) return { result: 'NOT_OFFERED' };

    const rerouted = await this.reroute(ins, 'DECLINED', now, reasonCode);
    if (rerouted.status === 'NOOP') {
      // A concurrent Accept won the insertion out from under this decline — no longer actionable.
      const fresh = await this.prisma.intradayInsertion.findUnique({ where: { insertionId } });
      return { result: 'NOT_PENDING', status: fresh?.status ?? ins.status };
    }
    return { result: 'OK', status: rerouted.status, nextSeId: rerouted.nextSeId };
  }

  /**
   * Acceptance Timeout sweep (Issue 30): every PENDING insertion past its 10-min deadline times out and
   * reroutes to the next-best SE; the timed-out SE gets a ghost-assignment notice on reconnect. After 3
   * reroutes the insertion escalates to the ZM.
   */
  async sweepTimeouts(now: Date = new Date()): Promise<{ timedOut: number; rerouted: number; escalated: number }> {
    const due = await this.prisma.intradayInsertion.findMany({
      where: { status: 'PENDING_ACCEPTANCE', acceptanceDeadline: { lte: now } },
    });
    let rerouted = 0;
    let escalated = 0;
    for (const ins of due) {
      const r = await this.reroute(ins, 'TIMED_OUT', now);
      if (r.status === 'ESCALATION_REQUIRED') escalated++;
      else if (r.status === 'PENDING_ACCEPTANCE') rerouted++;
      // NOOP: a concurrent Accept won this insertion between the query and the reroute — nothing to do.
    }
    return { timedOut: due.length, rerouted, escalated };
  }

  /** Available candidate SEs for the ZM manual-assignment modal (Issue 30) — `AVAILABLE` only, no ping filter. */
  async availableSesForManualAssign(insertionId: bigint, now: Date = new Date()): Promise<string[]> {
    const ins = await this.prisma.intradayInsertion.findUnique({
      where: { insertionId },
      include: { ticket: { select: { plantId: true } } },
    });
    if (!ins) return [];
    return this.availableCandidates(ins.ticket.plantId, now);
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
    const assigned = await this.override.assignTicket(
      ins.ticketId,
      seId,
      scope,
      actor,
      now,
      'CRITICAL_ASSIGN',
      true,
      deferral,
    );
    if (assigned.result === 'ALREADY_ASSIGNED') return { result: 'ALREADY_ASSIGNED' };
    // #265 — carried through verbatim instead of flattened. `NOT_FOUND` stays what it always meant:
    // the insertion, ticket or SE genuinely is not there.
    if (assigned.result === 'CONFLICT_DEFERRED') return assigned;
    if (assigned.result === 'REASON_REQUIRED') return { result: 'REASON_REQUIRED' };
    if (assigned.result !== 'OK') return { result: 'NOT_FOUND' };

    await this.prisma.intradayInsertion.update({
      where: { insertionId },
      data: {
        status: 'ACCEPTED',
        offeredSeId: seId,
        respondedAt: now,
        assignedScheduleId: BigInt(assigned.scheduleId),
        assignedBatchId: BigInt(assigned.batchId),
      },
    });
    await this.notifications.notify({
      recipients: [{ userId: seId, role: 'SERVICE_ENGINEER' }],
      type: 'INTRADAY_MANUAL_ASSIGNED',
      title: 'CRITICAL insertion assigned to you',
      body: `Ticket ${ins.ticketId} added to your Day Plan by your manager.`,
      entityType: 'ticket',
      entityId: ins.ticketId,
      metadata: { insertionId: String(insertionId), ticketId: ins.ticketId },
    });
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
    return rows.map((r) => this.toRow(r));
  }

  /** #163 item 3 — `GET /api/me/intraday-insertions`. The caller's own currently-live offer(s) —
   *  `PENDING_ACCEPTANCE` and `offeredSeId === seId` — so a restarted app can recover the offer screen
   *  (deadline included) purely from a re-read instead of scraping notifications. Empty when nothing
   *  is currently offered; never a 403 for "no offer" (that is not a permissions question). */
  async getMyPendingOffers(seId: string): Promise<IntradayInsertionRow[]> {
    const rows = await this.prisma.intradayInsertion.findMany({
      where: { offeredSeId: seId, status: 'PENDING_ACCEPTANCE' },
      orderBy: { offeredAt: 'desc' },
      include: { ticket: { select: { companyId: true, companyTier: true } } },
    });
    return rows.map((r) => this.toRow(r));
  }

  private toRow(
    r: Prisma.IntradayInsertionGetPayload<{ include: { ticket: { select: { companyId: true; companyTier: true } } } }>,
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
      acceptanceDeadline: r.acceptanceDeadline.toISOString(),
      status: r.status,
      declineReasonCode: r.declineReasonCode,
      retryCount: r.retryCount,
      retryChain: (r.retryChain as unknown as RetryAttempt[]) ?? [],
      whatsappSent: r.whatsappSentAt !== null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  // ---- internals ---------------------------------------------------------

  /** Create the PENDING offer + the in-app push with notification-shade Accept/Decline quick actions. */
  private async offer(ticket: ActiveInsertionTicket, seId: string, zoneId: bigint, now: Date): Promise<bigint> {
    const ins = await this.prisma.intradayInsertion.create({
      data: {
        ticketId: ticket.ticketId,
        zoneId,
        insertionType: 'SYSTEM_CRITICAL',
        slaBucket: ticket.device.state?.slaBucket ?? null,
        offeredSeId: seId,
        offeredAt: now,
        acceptanceDeadline: this.deadline(now),
        status: 'PENDING_ACCEPTANCE',
      },
    });
    await this.pushOffer(ins.insertionId, ticket.ticketId, seId);
    await this.prisma.auditLog.create({
      data: {
        actorId: seId,
        actorRole: 'SERVICE_ENGINEER',
        action: 'INTRADAY_OFFER',
        entityType: 'intraday_insertion',
        entityId: String(ins.insertionId),
        metadata: { ticketId: ticket.ticketId, seId } as Prisma.InputJsonValue,
      },
    });
    return ins.insertionId;
  }

  /** In-app push carrying the Accept/Decline quick-action payload (Issue 29 AC#2). */
  private async pushOffer(insertionId: bigint, ticketId: string, seId: string): Promise<void> {
    await this.notifications.notify({
      recipients: [{ userId: seId, role: 'SERVICE_ENGINEER' }],
      type: 'INTRADAY_CRITICAL_OFFER',
      title: 'Urgent CRITICAL ticket offered',
      body: `Accept within ${ACCEPTANCE_TIMEOUT_MIN} minutes.`,
      entityType: 'ticket',
      entityId: ticketId,
      deliveryModel: 'GENERAL',
      metadata: { insertionId: String(insertionId), ticketId, actions: ['ACCEPT', 'DECLINE'] },
    });
  }

  /**
   * Shared reroute for Decline and Timeout: record the failed attempt in `retryChain`, then offer to the
   * next-best untried available candidate. If 3 reroutes are exhausted or no candidate remains, escalate
   * to the ZM. On a TIMED_OUT reroute the previous SE gets a ghost-assignment notice (they were offline).
   */
  private async reroute(
    ins: { insertionId: bigint; ticketId: string; zoneId: bigint; offeredSeId: string; offeredAt: Date; retryCount: number; retryChain: Prisma.JsonValue },
    outcome: 'TIMED_OUT' | 'DECLINED',
    now: Date,
    reasonCode?: string,
  ): Promise<{ status: 'PENDING_ACCEPTANCE' | 'ESCALATION_REQUIRED' | 'NOOP'; nextSeId: string | null }> {
    const ticket = await this.prisma.ticket.findUniqueOrThrow({ where: { ticketId: ins.ticketId }, include: { plant: true } });
    const chain: RetryAttempt[] = ((ins.retryChain as unknown as RetryAttempt[]) ?? []).slice();
    chain.push({
      seId: ins.offeredSeId,
      offeredAt: ins.offeredAt.toISOString(),
      outcome,
      reasonCode: reasonCode ?? null,
      at: now.toISOString(),
    });

    const triedSeIds = new Set<string>([ins.offeredSeId, ...chain.map((a) => a.seId)]);
    const available = await this.availableCandidates(ticket.plantId, now);
    const next = available.find((id) => !triedSeIds.has(id)) ?? null;
    const exhausted = ins.retryCount >= MAX_RETRIES || next === null;

    // Atomic claim (Issue 101): only reroute if the insertion is STILL the exact PENDING offer we read
    // (same status + offered SE + retry count). A concurrent Accept flips it to ACCEPTED first, so our
    // guarded update hits 0 rows and we NO-OP — never re-offering, escalating, or ghost-notifying a ticket
    // the SE already accepted. The side effects fire only AFTER the claim is won.
    const guard = {
      insertionId: ins.insertionId,
      status: 'PENDING_ACCEPTANCE' as const,
      offeredSeId: ins.offeredSeId,
      retryCount: ins.retryCount,
    };

    if (exhausted || next === null) {
      const claim = await transitionOrConflict(this.prisma.intradayInsertion, guard, {
        status: 'ESCALATION_REQUIRED',
        respondedAt: now,
        declineReasonCode: reasonCode ?? null,
        retryChain: chain as unknown as Prisma.InputJsonValue,
      });
      if (!claim.won) return { status: 'NOOP', nextSeId: null };
      if (outcome === 'TIMED_OUT') await this.notifyGhostAssignment(ins.offeredSeId, ins.ticketId, null, now);
      await this.escalateToZm(ins.zoneId, ins.ticketId, ins.insertionId);
      return { status: 'ESCALATION_REQUIRED', nextSeId: null };
    }

    const claim = await transitionOrConflict(this.prisma.intradayInsertion, guard, {
      status: 'PENDING_ACCEPTANCE',
      offeredSeId: next,
      offeredAt: now,
      acceptanceDeadline: this.deadline(now),
      respondedAt: null,
      declineReasonCode: null,
      retryCount: ins.retryCount + 1,
      retryChain: chain as unknown as Prisma.InputJsonValue,
    });
    if (!claim.won) return { status: 'NOOP', nextSeId: null };
    if (outcome === 'TIMED_OUT') await this.notifyGhostAssignment(ins.offeredSeId, ins.ticketId, next, now);
    await this.pushOffer(ins.insertionId, ins.ticketId, next);
    return { status: 'PENDING_ACCEPTANCE', nextSeId: next };
  }

  /** "Ticket-XXXX was offered to you and routed to [SE] because you didn't respond in time. No action needed."
   *  PRD:547 wants the SE's name, not their id — resolved here rather than shipping the raw UUID a
   *  field engineer can't act on (same fix class as #63's `winnerSeName`). */
  private async notifyGhostAssignment(prevSeId: string, ticketId: string, nextSeId: string | null, _now: Date): Promise<void> {
    let routed = 'escalated to your manager';
    if (nextSeId) {
      const next = await this.prisma.user.findUnique({ where: { userId: nextSeId }, select: { name: true } });
      routed = `routed to ${next?.name ?? 'another engineer'}`;
    }
    await this.notifications.notify({
      recipients: [{ userId: prevSeId, role: 'SERVICE_ENGINEER' }],
      type: 'INTRADAY_GHOST_ASSIGNMENT',
      title: 'Offer routed on',
      body: `Ticket ${ticketId} was offered to you and ${routed} because you didn't respond in time. No action needed.`,
      entityType: 'ticket',
      entityId: ticketId,
      deliveryModel: 'GENERAL',
      metadata: { ticketId, routedTo: nextSeId },
    });
  }

  /** Escalate to the zone's ZM "Manual assignment needed" Action-Required alert (Issue 30). */
  private async escalateToZm(zoneId: bigint, ticketId: string, insertionId: bigint): Promise<void> {
    const zone = await this.prisma.zone.findUnique({ where: { zoneId } });
    if (!zone?.zonalManagerUserId) return;
    await this.notifications.notify({
      recipients: [{ userId: zone.zonalManagerUserId, role: 'ZONAL_MANAGER' }],
      type: 'INTRADAY_ESCALATION_REQUIRED',
      title: 'Manual assignment needed',
      body: `CRITICAL ticket ${ticketId} could not be auto-assigned after ${MAX_RETRIES} retries.`,
      entityType: 'ticket',
      entityId: ticketId,
      deliveryModel: 'GENERAL',
      metadata: { insertionId: String(insertionId), ticketId },
    });
  }

  /** Strict-precedence candidate SEs for a plant filtered to `AVAILABLE` (no activity-ping filter). */
  private async availableCandidates(plantId: bigint, now: Date): Promise<string[]> {
    const ordered = await this.candidates.orderedCandidatesForPlant(plantId);
    if (ordered.length === 0) return [];
    const statuses = await this.availability.currentStatusMany(
      ordered.map((c) => c.seId),
      now,
    );
    return ordered.filter((c) => (statuses.get(c.seId) ?? 'AVAILABLE') === 'AVAILABLE').map((c) => c.seId);
  }

  private deadline(now: Date): Date {
    return new Date(now.getTime() + ACCEPTANCE_TIMEOUT_MIN * 60_000);
  }
}
