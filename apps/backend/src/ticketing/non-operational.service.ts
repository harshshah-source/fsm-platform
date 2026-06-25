import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { $Enums } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CUSTOMER_CONFIRMATION_NOTIFIER,
  type CustomerConfirmationNotifier,
  LoggingCustomerConfirmationNotifier,
} from './customer-confirmation-notifier';

type NonOpReason = $Enums.NonOpReason;
type NonOpState = $Enums.NonOpState;

const DAY_MS = 86_400_000;

/** Reasons whose default effective window is 365 days; everything else defaults to 90 (CONTEXT §14). */
const LONG_WINDOW_REASONS = new Set<NonOpReason>(['VEHICLE_SCRAPPED', 'VEHICLE_SOLD']);

/** States that surface on the dual-confirmation work queue (awaiting either party, or just confirmed). */
const QUEUE_STATES: NonOpState[] = [
  'AWAITING_ZM_CONFIRMATION',
  'AWAITING_CUSTOMER_CONFIRMATION',
  'CONFIRMED',
];

/** Roles that may perform the manager leg of the dual confirmation (CONTEXT §14/§15). */
const MANAGER_ROLES = new Set(['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']);

/** States still open to a confirmation (manager or customer) — i.e. not yet CONFIRMED/terminal. */
const AWAITING_STATES = new Set<NonOpState>([
  'AWAITING_ZM_CONFIRMATION',
  'AWAITING_CUSTOMER_CONFIRMATION',
]);

/** Operations Head may override-confirm only after this many days of no response (CONTEXT §14). */
const OVERRIDE_AFTER_DAYS = 7;

/** One-time customer-confirmation token lifetime — comfortably past the 7-day override window. */
const TOKEN_TTL_DAYS = 30;

/** Base URL the customer confirmation link points at (Issue 03 owns real delivery). */
const PUBLIC_API_URL = process.env.PUBLIC_API_URL ?? 'http://localhost:3000';

/** In-flight ticket statuses that a CONFIRMED Non-Op marking auto-closes (CLOSED_NON_OPERATIONAL). */
const IN_FLIGHT_TICKET_STATES: $Enums.TicketStatus[] = [
  'OPEN',
  'SUBMITTED',
  'VERIFICATION_PENDING',
  'ESCALATED',
];

/** Reasons that, for a RECURRING (provider-owned) device, trigger Recovery-Ticket auto-creation. */
const RECOVERY_REASONS = new Set<NonOpReason>([
  'VEHICLE_SCRAPPED',
  'VEHICLE_SOLD',
  'COMPANY_PAUSED',
  'DEVICE_REPLACEMENT_PENDING',
]);

export interface RequestMarkingInput {
  deviceId: bigint;
  reasonCode: NonOpReason;
  reasonText?: string | null;
  /** Window start; defaults to `now`. */
  effectiveFrom?: Date;
  /** Window end; defaults to start + (365 for scrapped/sold, else 90) days. */
  effectiveTo?: Date;
}

export interface NonOpMarkingView {
  markingId: string;
  deviceId: bigint;
  state: NonOpState;
  reasonCode: NonOpReason | null;
  reasonText: string | null;
  dealTypeAtMarking: string | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  awaitingSince: Date | null;
  /** The auto-created RECOVERY ticket id once CONFIRMED for a qualifying RECURRING device (AC#4). */
  recoveryTicketId: string | null;
}

export type RequestMarkingOutcome =
  | { result: 'OK'; marking: NonOpMarkingView }
  | { result: 'NOT_FOUND' }
  | { result: 'INVALID_REASON_TEXT' }
  | { result: 'CONFLICT' };

export type ConfirmOutcome =
  | { result: 'OK'; marking: NonOpMarkingView }
  | { result: 'NOT_FOUND' }
  | { result: 'FORBIDDEN' }
  | { result: 'ALREADY' };

export type ConfirmTokenOutcome = ConfirmOutcome | { result: 'EXPIRED' };

export type OverrideOutcome =
  | { result: 'OK'; marking: NonOpMarkingView }
  | { result: 'NOT_FOUND' }
  | { result: 'FORBIDDEN' }
  | { result: 'ALREADY' }
  | { result: 'REASON_REQUIRED' }
  | { result: 'TOO_EARLY' };

/** A row as returned by `tx.nonOperationalMarking.*`; narrowed to the columns the service reads. */
type MarkingRow = {
  markingId: string;
  deviceId: bigint;
  state: NonOpState;
  reasonCode: NonOpReason | null;
  reasonText: string | null;
  dealTypeAtMarking: string | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  awaitingSince: Date | null;
  recoveryTicketId: string | null;
  createdAt: Date;
  managerConfirmedAt: Date | null;
  managerConfirmedBy: string | null;
  customerConfirmedAt: Date | null;
};

/** One dual-confirmation queue row — the marking view plus its days-elapsed badge. */
export interface NonOpQueueRow extends NonOpMarkingView {
  daysElapsed: number;
}

/**
 * Non-Operational dual-confirmation marking lifecycle (Issue 35, CONTEXT.md §14). A manager
 * (ZM / CSM / Operations Head) requests a marking; it then needs BOTH manager and customer
 * confirmation before it becomes CONFIRMED and the device leaves the eligible set. This slice owns
 * the request + the dual-confirmation queue read; confirmation transitions land in later slices.
 */
@Injectable()
export class NonOperationalService {
  private readonly notifier: CustomerConfirmationNotifier;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional()
    @Inject(CUSTOMER_CONFIRMATION_NOTIFIER)
    notifier?: CustomerConfirmationNotifier,
  ) {
    this.notifier = notifier ?? new LoggingCustomerConfirmationNotifier();
  }

  /**
   * Requests a Non-Operational marking for a device — snapshots its deal type, defaults the
   * effective window by reason, stamps `awaiting_since`, and parks at AWAITING_ZM_CONFIRMATION.
   * One active marking per device (CONTEXT invariant I13); `OTHER` requires free text.
   */
  async requestMarking(
    input: RequestMarkingInput,
    actor: RequestActor,
    now: Date = new Date(),
  ): Promise<RequestMarkingOutcome> {
    if (input.reasonCode === 'OTHER' && !input.reasonText?.trim()) {
      return { result: 'INVALID_REASON_TEXT' };
    }
    const device = await this.prisma.device.findUnique({ where: { deviceId: input.deviceId } });
    if (!device) return { result: 'NOT_FOUND' };

    const active = await this.prisma.nonOperationalMarking.findFirst({
      where: { deviceId: input.deviceId, state: { in: QUEUE_STATES } },
    });
    if (active) return { result: 'CONFLICT' };

    const effectiveFrom = input.effectiveFrom ?? now;
    const windowDays = LONG_WINDOW_REASONS.has(input.reasonCode) ? 365 : 90;
    const effectiveTo = input.effectiveTo ?? new Date(effectiveFrom.getTime() + windowDays * DAY_MS);
    const customerToken = randomUUID();
    const customerTokenExpiresAt = new Date(now.getTime() + TOKEN_TTL_DAYS * DAY_MS);

    const marking = await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'NON_OP_REQUESTED',
        entityType: 'non_operational_markings',
        entityId: String(input.deviceId),
        metadata: { reasonCode: input.reasonCode, dealTypeAtMarking: device.dealType ?? null },
      },
      (tx) =>
        tx.nonOperationalMarking.create({
          data: {
            deviceId: input.deviceId,
            state: 'AWAITING_ZM_CONFIRMATION',
            reasonCode: input.reasonCode,
            reasonText: input.reasonText ?? null,
            dealTypeAtMarking: device.dealType ?? null,
            requestedBy: isUuid(actor.userId) ? actor.userId : null,
            requestedByRole: actor.role as $Enums.Role,
            awaitingSince: now,
            effectiveFrom,
            effectiveTo,
            customerToken,
            customerTokenExpiresAt,
          },
        }),
    );

    // Fire the one-time customer confirmation link after commit (Issue 03 owns real delivery).
    await this.notifier.sendConfirmationLink({
      markingId: marking.markingId,
      deviceId: marking.deviceId,
      token: customerToken,
      confirmUrl: `${PUBLIC_API_URL}/api/non-op/confirm?token=${customerToken}`,
    });
    return { result: 'OK', marking: toView(marking) };
  }

  /** The dual-confirmation queue: open rows sorted by `awaiting_since` asc, each with a days badge. */
  async queue(now: Date = new Date()): Promise<NonOpQueueRow[]> {
    const rows = await this.prisma.nonOperationalMarking.findMany({
      where: { state: { in: QUEUE_STATES } },
      orderBy: { awaitingSince: 'asc' },
    });
    return rows.map((row) => ({
      ...toView(row),
      daysElapsed: row.awaitingSince
        ? Math.floor((now.getTime() - row.awaitingSince.getTime()) / DAY_MS)
        : 0,
    }));
  }

  /** Manager leg of the dual confirmation (ZM / CSM / Operations Head). */
  async confirmByManager(
    markingId: string,
    actor: RequestActor,
    now: Date = new Date(),
  ): Promise<ConfirmOutcome> {
    if (!MANAGER_ROLES.has(actor.role)) return { result: 'FORBIDDEN' };
    const marking = await this.prisma.nonOperationalMarking.findUnique({ where: { markingId } });
    if (!marking) return { result: 'NOT_FOUND' };
    if (!AWAITING_STATES.has(marking.state)) return { result: 'ALREADY' };

    const updated = await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'NON_OP_MANAGER_CONFIRMED',
        entityType: 'non_operational_markings',
        entityId: String(marking.deviceId),
      },
      (tx) => this.applyConfirmation(tx, marking, { manager: true, now, actor }),
    );
    return { result: 'OK', marking: toView(updated) };
  }

  /** Customer leg of the dual confirmation — driven by the one-time tokenised email link (slice 4). */
  async confirmByCustomer(markingId: string, now: Date = new Date()): Promise<ConfirmOutcome> {
    const marking = await this.prisma.nonOperationalMarking.findUnique({ where: { markingId } });
    if (!marking) return { result: 'NOT_FOUND' };
    if (!AWAITING_STATES.has(marking.state)) return { result: 'ALREADY' };

    const updated = await this.audit.withAudit(
      {
        actorId: 'CUSTOMER',
        actorRole: 'CUSTOMER',
        action: 'NON_OP_CUSTOMER_CONFIRMED',
        entityType: 'non_operational_markings',
        entityId: String(marking.deviceId),
      },
      (tx) => this.applyConfirmation(tx, marking, { customer: true, now }),
    );
    return { result: 'OK', marking: toView(updated) };
  }

  /**
   * Customer confirmation via the one-time tokenised email link (AC#6). Resolves the marking by its
   * token, rejects an unknown or expired token, then applies the customer leg and consumes the token.
   */
  async confirmByCustomerToken(token: string, now: Date = new Date()): Promise<ConfirmTokenOutcome> {
    const marking = await this.prisma.nonOperationalMarking.findFirst({
      where: { customerToken: token },
    });
    if (!marking) return { result: 'NOT_FOUND' };
    if (marking.customerTokenExpiresAt && marking.customerTokenExpiresAt.getTime() < now.getTime()) {
      return { result: 'EXPIRED' };
    }
    const outcome = await this.confirmByCustomer(marking.markingId, now);
    if (outcome.result === 'OK') {
      // One-time: burn the token so the link can't be replayed.
      await this.prisma.nonOperationalMarking.update({
        where: { markingId: marking.markingId },
        data: { customerToken: null },
      });
    }
    return outcome;
  }

  /**
   * Operations-Head override-confirm — fills the missing party after 7 days of no response, with a
   * mandatory free-text audit reason (CONTEXT §14). OH-only; not reachable before the 7-day gate.
   */
  async overrideConfirm(
    markingId: string,
    actor: RequestActor,
    reason: string,
    now: Date = new Date(),
  ): Promise<OverrideOutcome> {
    if (actor.role !== 'OPERATIONS_HEAD') return { result: 'FORBIDDEN' };
    const marking = await this.prisma.nonOperationalMarking.findUnique({ where: { markingId } });
    if (!marking) return { result: 'NOT_FOUND' };
    if (!AWAITING_STATES.has(marking.state)) return { result: 'ALREADY' };
    if (!reason?.trim()) return { result: 'REASON_REQUIRED' };
    const awaitingSince = marking.awaitingSince ?? marking.createdAt;
    if (now.getTime() - awaitingSince.getTime() < OVERRIDE_AFTER_DAYS * DAY_MS) {
      return { result: 'TOO_EARLY' };
    }

    const updated = await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'NON_OP_OVERRIDE_CONFIRMED',
        entityType: 'non_operational_markings',
        entityId: String(marking.deviceId),
        metadata: { overrideReason: reason.trim() },
      },
      (tx) =>
        this.markConfirmed(tx, marking, now, {
          managerConfirmedAt: marking.managerConfirmedAt ?? now,
          customerConfirmedAt: marking.customerConfirmedAt ?? now,
          overrideConfirmedBy: isUuid(actor.userId) ? actor.userId : null,
          overrideReason: reason.trim(),
        }),
    );
    return { result: 'OK', marking: toView(updated) };
  }

  /**
   * Applies one confirmation leg and advances the lifecycle: both legs present → CONFIRMED;
   * otherwise the row parks at the still-outstanding party and resets `awaiting_since` so the
   * days-elapsed badge counts the new wait. Runs inside the caller's audited transaction.
   */
  private async applyConfirmation(
    tx: PrismaTx,
    marking: MarkingRow,
    leg: { manager?: boolean; customer?: boolean; now: Date; actor?: RequestActor },
  ): Promise<MarkingRow> {
    const managerAt = leg.manager ? leg.now : marking.managerConfirmedAt;
    const customerAt = leg.customer ? leg.now : marking.customerConfirmedAt;
    const managerBy =
      leg.manager && leg.actor && isUuid(leg.actor.userId)
        ? leg.actor.userId
        : marking.managerConfirmedBy;

    if (managerAt && customerAt) {
      return this.markConfirmed(tx, marking, leg.now, {
        managerConfirmedAt: managerAt,
        managerConfirmedBy: managerBy,
        customerConfirmedAt: customerAt,
      });
    }
    return tx.nonOperationalMarking.update({
      where: { markingId: marking.markingId },
      data: {
        managerConfirmedAt: managerAt,
        managerConfirmedBy: managerBy,
        customerConfirmedAt: customerAt,
        state: managerAt ? 'AWAITING_CUSTOMER_CONFIRMATION' : 'AWAITING_ZM_CONFIRMATION',
        awaitingSince: leg.now,
      },
    });
  }

  /**
   * Drives the marking to CONFIRMED and fires the side-effects in the same transaction (CONTEXT §14):
   * in-flight tickets auto-close as CLOSED_NON_OPERATIONAL (back-referenced + lifecycle-evented), the
   * device leaves the eligible set (which also blocks new Failure Cycles), and a qualifying RECURRING
   * device gets a RECOVERY ticket queued. `extra` carries the confirming party fields (dual or override).
   */
  private async markConfirmed(
    tx: PrismaTx,
    marking: MarkingRow,
    now: Date,
    extra: Record<string, unknown>,
  ): Promise<MarkingRow> {
    await tx.nonOperationalMarking.update({
      where: { markingId: marking.markingId },
      data: { state: 'CONFIRMED', confirmedAt: now, ...extra },
    });
    const recoveryTicketId = await this.runConfirmedSideEffects(tx, marking, now);
    return tx.nonOperationalMarking.update({
      where: { markingId: marking.markingId },
      data: recoveryTicketId ? { recoveryTicketId } : {},
    });
  }

  /** Auto-close in-flight tickets, exclude the device from eligibility, queue a Recovery ticket. */
  private async runConfirmedSideEffects(
    tx: PrismaTx,
    marking: MarkingRow,
    now: Date,
  ): Promise<string | null> {
    const open = await tx.ticket.findMany({
      where: { deviceId: marking.deviceId, status: { in: IN_FLIGHT_TICKET_STATES } },
    });
    for (const ticket of open) {
      await tx.ticket.update({
        where: { ticketId: ticket.ticketId },
        data: {
          status: 'CLOSED_NON_OPERATIONAL',
          lastStateChangedAt: now,
          nonOpMarkingId: marking.markingId,
        },
      });
      await tx.ticketEvent.create({
        data: {
          ticketId: ticket.ticketId,
          fromState: ticket.status,
          toState: 'CLOSED_NON_OPERATIONAL',
          reasonCode: 'NON_OPERATIONAL',
          at: now,
        },
      });
      // Terminate the parent Failure Cycle — there is no NON_OPERATIONAL cycle state, so the cycle is
      // closed via `closedAt` (the device left service; it never recovers) and the open-flag cleared.
      if (ticket.failureCycleId) {
        await tx.failureCycle.update({
          where: { cycleId: ticket.failureCycleId },
          data: { closedAt: now },
        });
      }
    }

    // Leaving the eligible set both excludes the device from the Fleet-Uptime denominator (AC#5) and
    // blocks new Failure Cycles (the ticket-creation gate requires eligible_for_uptime = true) (AC#3).
    await tx.deviceState.updateMany({
      where: { deviceId: marking.deviceId },
      data: { eligibleForUptime: false, hasOpenFailureCycle: false },
    });

    return this.maybeCreateRecoveryTicket(tx, marking, now);
  }

  /** RECURRING-deal physical-retrieval reason → create a RECOVERY ticket in REQUESTED, queued. */
  private async maybeCreateRecoveryTicket(
    tx: PrismaTx,
    marking: MarkingRow,
    now: Date,
  ): Promise<string | null> {
    const qualifies =
      marking.dealTypeAtMarking === 'RECURRING' &&
      marking.reasonCode != null &&
      RECOVERY_REASONS.has(marking.reasonCode);
    if (!qualifies) return null;

    // Denormalised fitment for the new ticket comes from the device's hot state row.
    const state = await tx.deviceState.findUnique({ where: { deviceId: marking.deviceId } });
    if (!state?.plantId || !state.companyId) return null;
    const company = await tx.company.findUnique({ where: { companyId: state.companyId } });
    if (!company) return null;

    const recovery = await tx.ticket.create({
      data: {
        workType: 'RECOVERY',
        status: 'REQUESTED',
        deviceId: marking.deviceId,
        vehicleId: state.vehicleId,
        plantId: state.plantId,
        companyId: state.companyId,
        companyTier: company.companyTier,
        lastStateChangedAt: now,
        nonOpMarkingId: marking.markingId,
      },
    });
    await tx.ticketEvent.create({
      data: {
        ticketId: recovery.ticketId,
        fromState: null,
        toState: 'REQUESTED',
        reasonCode: marking.reasonCode,
        at: now,
      },
    });
    return recovery.ticketId;
  }
}

/** The interactive-transaction client AuditService.withAudit hands to the work callback. */
type PrismaTx = Parameters<Parameters<AuditService['withAudit']>[1]>[0];

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function toView(row: {
  markingId: string;
  deviceId: bigint;
  state: NonOpState;
  reasonCode: NonOpReason | null;
  reasonText: string | null;
  dealTypeAtMarking: string | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  awaitingSince: Date | null;
  recoveryTicketId: string | null;
}): NonOpMarkingView {
  return {
    markingId: row.markingId,
    deviceId: row.deviceId,
    state: row.state,
    reasonCode: row.reasonCode,
    reasonText: row.reasonText,
    dealTypeAtMarking: row.dealTypeAtMarking,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    awaitingSince: row.awaitingSince,
    recoveryTicketId: row.recoveryTicketId,
  };
}
