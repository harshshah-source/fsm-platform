import { Inject, Injectable, Optional } from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { $Enums } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  LoggingRecoveryNotifier,
  RECOVERY_NOTIFIER,
  type RecoveryNotifier,
} from './recovery-notifier';

type TicketStatus = $Enums.TicketStatus;
type UnableToCollectReason = $Enums.UnableToCollectReason;

/** Roles that schedule (dispatch/assign) a Recovery Ticket to an SE. */
const MANAGER_ROLES = new Set(['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']);

/** Valid SE "Unable to Collect" reason codes (CONTEXT §14 / Issue 36). */
const UNABLE_REASONS = new Set<UnableToCollectReason>([
  'COMPANY_REFUSED',
  'VEHICLE_UNREACHABLE',
  'DEVICE_MISSING',
  'OTHER',
]);

export interface RecoveryView {
  ticketId: string;
  status: TicketStatus;
  deviceId: bigint;
  assignedSeId: string | null;
  collectedDeviceSerial: string | null;
  collectionConditionNotes: string | null;
  unableToCollectReason: $Enums.UnableToCollectReason | null;
  closureType: $Enums.ClosureType | null;
  closedAt: Date | null;
}

export type RecoveryOutcome =
  | { result: 'OK'; ticket: RecoveryView }
  | { result: 'NOT_FOUND' }
  | { result: 'WRONG_STATE' }
  | { result: 'FORBIDDEN' }
  | { result: 'INVALID_SERIAL' }
  | { result: 'NOTES_REQUIRED' }
  | { result: 'INVALID_REASON' }
  | { result: 'REASON_REQUIRED' };

/** The minimal ticket shape the service reads for a recovery transition. */
type TicketRow = {
  ticketId: string;
  workType: $Enums.WorkType;
  status: TicketStatus;
  deviceId: bigint;
  assignedSeId: string | null;
  unableToCollectReason: $Enums.UnableToCollectReason | null;
  collectedDeviceSerial: string | null;
};

/** Recovery statuses past which no decision-queue action or manual close applies. */
const TERMINAL_STATES = new Set<TicketStatus>(['CLOSED', 'FAILED_RECOVERY']);

/** Days without state progression after which a Recovery Ticket is "stalled" (CONTEXT §14). */
const STALL_DAYS = 14;
const DAY_MS = 86_400_000;

/** Manual closure types (every closure that is NOT the automatic warehouse-receipt close). */
const MANUAL_CLOSURE_TYPES: $Enums.ClosureType[] = [
  'FAILED_RECOVERY_CLOSE',
  'ZM_MANUAL_CLOSE',
  'OPERATIONS_HEAD_OVERRIDE_CLOSE',
  'CSM_ACTING_CLOSE',
];

/**
 * Recovery Ticket field workflow (Issue 36, CONTEXT.md §14). Lifecycle
 * REQUESTED → SCHEDULED → ON_SITE → COLLECTED → RECEIVED_AT_WAREHOUSE → CLOSED. This slice owns the
 * schedule + the SE field legs (on-site, the Collection Form); warehouse receipt auto-close and the
 * unable-to-collect routing land in the next slice. Every transition is state-guarded, audited, and
 * appends a `ticket_events` row.
 */
@Injectable()
export class RecoveryService {
  private readonly notifier: RecoveryNotifier;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() @Inject(RECOVERY_NOTIFIER) notifier?: RecoveryNotifier,
  ) {
    this.notifier = notifier ?? new LoggingRecoveryNotifier();
  }

  /** Dispatch a Recovery Ticket to an SE: REQUESTED → SCHEDULED (manager roles). */
  async scheduleRecovery(ticketId: string, seId: string, actor: RequestActor): Promise<RecoveryOutcome> {
    if (!MANAGER_ROLES.has(actor.role)) return { result: 'FORBIDDEN' };
    const ticket = await this.load(ticketId);
    if (!ticket) return { result: 'NOT_FOUND' };
    if (ticket.status !== 'REQUESTED') return { result: 'WRONG_STATE' };
    return this.transition(ticket, 'SCHEDULED', actor, 'RECOVERY_SCHEDULED', { assignedSeId: seId });
  }

  /** SE arrives at the collection site: SCHEDULED → ON_SITE (assigned SE only). */
  async markOnSite(ticketId: string, actor: RequestActor): Promise<RecoveryOutcome> {
    const ticket = await this.load(ticketId);
    if (!ticket) return { result: 'NOT_FOUND' };
    if (ticket.status !== 'SCHEDULED') return { result: 'WRONG_STATE' };
    if (!this.isAssignedSe(ticket, actor)) return { result: 'FORBIDDEN' };
    return this.transition(ticket, 'ON_SITE', actor, 'RECOVERY_ON_SITE', {});
  }

  /**
   * Collection Form: ON_SITE → COLLECTED (assigned SE). The device serial is mandatory and validated
   * against the ticket's device; condition notes are mandatory.
   */
  async markCollected(
    ticketId: string,
    input: { deviceSerial: string; conditionNotes: string },
    actor: RequestActor,
  ): Promise<RecoveryOutcome> {
    const ticket = await this.load(ticketId);
    if (!ticket) return { result: 'NOT_FOUND' };
    if (ticket.status !== 'ON_SITE') return { result: 'WRONG_STATE' };
    if (!this.isAssignedSe(ticket, actor)) return { result: 'FORBIDDEN' };
    if (input.deviceSerial?.trim() !== String(ticket.deviceId)) return { result: 'INVALID_SERIAL' };
    if (!input.conditionNotes?.trim()) return { result: 'NOTES_REQUIRED' };
    return this.transition(ticket, 'COLLECTED', actor, 'RECOVERY_COLLECTED', {
      collectedDeviceSerial: input.deviceSerial.trim(),
      collectionConditionNotes: input.conditionNotes.trim(),
    });
  }

  /**
   * Warehouse Manager confirms physical receipt of a COLLECTED device: COLLECTED →
   * RECEIVED_AT_WAREHOUSE → CLOSED (`AUTO_CLOSED_ON_WAREHOUSE_RECEIPT`, no ZM approval). SE + ZM are
   * notified (AC#3/#4).
   */
  async confirmWarehouseReceipt(ticketId: string, actor: RequestActor): Promise<RecoveryOutcome> {
    if (actor.role !== 'WAREHOUSE_MANAGER') return { result: 'FORBIDDEN' };
    const ticket = await this.load(ticketId);
    if (!ticket) return { result: 'NOT_FOUND' };
    if (ticket.status !== 'COLLECTED') return { result: 'WRONG_STATE' };

    const now = new Date();
    const updated = await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'RECOVERY_RECEIVED_AND_CLOSED',
        entityType: 'tickets',
        entityId: ticketId,
        metadata: { closureType: 'AUTO_CLOSED_ON_WAREHOUSE_RECEIPT' },
      },
      async (tx) => {
        // RECEIVED_AT_WAREHOUSE then the auto-close to CLOSED — both legs recorded in one tx.
        await tx.ticketEvent.create({ data: { ticketId, fromState: ticket.status, toState: 'RECEIVED_AT_WAREHOUSE', ...eventActor(actor), at: now } });
        const row = await tx.ticket.update({
          where: { ticketId },
          data: { status: 'CLOSED', closureType: 'AUTO_CLOSED_ON_WAREHOUSE_RECEIPT', closedAt: now, lastStateChangedAt: now },
        });
        await tx.ticketEvent.create({ data: { ticketId, fromState: 'RECEIVED_AT_WAREHOUSE', toState: 'CLOSED', reasonCode: 'AUTO_CLOSED_ON_WAREHOUSE_RECEIPT', ...eventActor(actor), at: now } });
        return row;
      },
    );
    await this.notifier.recoveryClosed({ ticketId, deviceId: ticket.deviceId, seId: ticket.assignedSeId });
    return { result: 'OK', ticket: toView(updated) };
  }

  /**
   * SE reports Unable to Collect (assigned SE, while ON_SITE) with a mandatory reason code; the ticket
   * is flagged and routed to the ZM decision queue (Issue 37) without leaving ON_SITE (AC#5).
   */
  async markUnableToCollect(
    ticketId: string,
    input: { reasonCode: UnableToCollectReason },
    actor: RequestActor,
  ): Promise<RecoveryOutcome> {
    const ticket = await this.load(ticketId);
    if (!ticket) return { result: 'NOT_FOUND' };
    if (ticket.status !== 'ON_SITE') return { result: 'WRONG_STATE' };
    if (!this.isAssignedSe(ticket, actor)) return { result: 'FORBIDDEN' };
    if (!UNABLE_REASONS.has(input.reasonCode)) return { result: 'INVALID_REASON' };

    const now = new Date();
    const updated = await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'RECOVERY_UNABLE_TO_COLLECT',
        entityType: 'tickets',
        entityId: ticketId,
        metadata: { reasonCode: input.reasonCode },
      },
      async (tx) => {
        const row = await tx.ticket.update({
          where: { ticketId },
          data: { unableToCollectReason: input.reasonCode, unableToCollectAt: now },
        });
        await tx.ticketEvent.create({ data: { ticketId, fromState: ticket.status, toState: 'ON_SITE', reasonCode: input.reasonCode, ...eventActor(actor), at: now } });
        return row;
      },
    );
    await this.notifier.unableToCollect({ ticketId, deviceId: ticket.deviceId, seId: ticket.assignedSeId, reasonCode: input.reasonCode });
    return { result: 'OK', ticket: toView(updated) };
  }

  /**
   * ZM decision-queue action — Reschedule: re-assign an unable-to-collect ticket for another attempt
   * (back to SCHEDULED), clearing the unable flag (AC#1). Manager roles.
   */
  async rescheduleRecovery(ticketId: string, seId: string, actor: RequestActor): Promise<RecoveryOutcome> {
    if (!MANAGER_ROLES.has(actor.role)) return { result: 'FORBIDDEN' };
    const ticket = await this.load(ticketId);
    if (!ticket) return { result: 'NOT_FOUND' };
    if (!this.inDecisionQueue(ticket)) return { result: 'WRONG_STATE' };
    return this.transition(ticket, 'SCHEDULED', actor, 'RECOVERY_RESCHEDULED', {
      assignedSeId: seId,
      unableToCollectReason: null,
      unableToCollectAt: null,
    });
  }

  /**
   * ZM decision-queue action — Close as FAILED_RECOVERY with a mandatory reason
   * (`closure_type = FAILED_RECOVERY_CLOSE`) (AC#1). Manager roles.
   */
  async closeFailedRecovery(ticketId: string, reason: string, actor: RequestActor): Promise<RecoveryOutcome> {
    if (!MANAGER_ROLES.has(actor.role)) return { result: 'FORBIDDEN' };
    const ticket = await this.load(ticketId);
    if (!ticket) return { result: 'NOT_FOUND' };
    if (!this.inDecisionQueue(ticket)) return { result: 'WRONG_STATE' };
    if (!reason?.trim()) return { result: 'REASON_REQUIRED' };
    return this.closeWith(ticket, 'FAILED_RECOVERY', 'FAILED_RECOVERY_CLOSE', reason.trim(), actor, 'RECOVERY_FAILED_CLOSE');
  }

  /** ZM decision-queue action — Escalate an unable-to-collect ticket to Operations Head (AC#1). */
  async escalateToOh(ticketId: string, actor: RequestActor): Promise<RecoveryOutcome> {
    if (!MANAGER_ROLES.has(actor.role)) return { result: 'FORBIDDEN' };
    const ticket = await this.load(ticketId);
    if (!ticket) return { result: 'NOT_FOUND' };
    if (!this.inDecisionQueue(ticket)) return { result: 'WRONG_STATE' };
    const out = await this.transition(ticket, ticket.status, actor, 'RECOVERY_ESCALATED_TO_OH', {});
    await this.notifier.escalatedToOh?.({ ticketId, deviceId: ticket.deviceId, escalatedByRole: actor.role });
    return out;
  }

  /**
   * Manual closure (web only, exception path) by ZM / Operations Head / CSM-acting with a mandatory
   * reason; the `closure_type` is set by the acting role and full audit fields are recorded
   * (previous_state + device_serial). Operations Head may close any zone (AC#2/#3).
   */
  async manualClose(ticketId: string, reason: string, actor: RequestActor): Promise<RecoveryOutcome> {
    if (!MANAGER_ROLES.has(actor.role)) return { result: 'FORBIDDEN' };
    const ticket = await this.load(ticketId);
    if (!ticket) return { result: 'NOT_FOUND' };
    if (TERMINAL_STATES.has(ticket.status)) return { result: 'WRONG_STATE' };
    if (!reason?.trim()) return { result: 'REASON_REQUIRED' };
    return this.closeWith(ticket, 'CLOSED', manualClosureType(actor.role), reason.trim(), actor, 'RECOVERY_MANUAL_CLOSE');
  }

  /** COLLECTED Recovery Tickets awaiting the Warehouse Manager's receipt confirmation (oldest first). */
  async awaitingReceipt(): Promise<RecoveryView[]> {
    const rows = await this.prisma.ticket.findMany({
      where: { workType: 'RECOVERY', status: 'COLLECTED' },
      orderBy: { lastStateChangedAt: 'asc' },
    });
    return rows.map(toView);
  }

  /** Recovery Tickets with no state progression for 14+ days — surface in ZM Action Required (AC#5). */
  async stalledRecoveries(now: Date = new Date()): Promise<RecoveryView[]> {
    const cutoff = new Date(now.getTime() - STALL_DAYS * DAY_MS);
    const rows = await this.prisma.ticket.findMany({
      where: { workType: 'RECOVERY', status: { notIn: ['CLOSED', 'FAILED_RECOVERY'] }, lastStateChangedAt: { lt: cutoff } },
      orderBy: { lastStateChangedAt: 'asc' },
    });
    return rows.map(toView);
  }

  /** Manual (non-auto-receipt) closures — the compliance report of non-standard closes (AC#4). */
  async nonStandardClosures(): Promise<RecoveryView[]> {
    const rows = await this.prisma.ticket.findMany({
      where: { workType: 'RECOVERY', closureType: { in: MANUAL_CLOSURE_TYPES } },
      orderBy: { closedAt: 'desc' },
    });
    return rows.map(toView);
  }

  /** Recovery Tickets flagged Unable to Collect and not yet resolved — the ZM decision queue (Issue 37). */
  async zmDecisionQueue(): Promise<RecoveryView[]> {
    const rows = await this.prisma.ticket.findMany({
      where: {
        workType: 'RECOVERY',
        unableToCollectReason: { not: null },
        status: { notIn: ['CLOSED', 'FAILED_RECOVERY'] },
      },
      orderBy: { unableToCollectAt: 'asc' },
    });
    return rows.map(toView);
  }

  private async load(ticketId: string): Promise<TicketRow | null> {
    const t = await this.prisma.ticket.findUnique({ where: { ticketId } });
    if (!t || t.workType !== 'RECOVERY') return null;
    return {
      ticketId: t.ticketId,
      workType: t.workType,
      status: t.status,
      deviceId: t.deviceId,
      assignedSeId: t.assignedSeId,
      unableToCollectReason: t.unableToCollectReason,
      collectedDeviceSerial: t.collectedDeviceSerial,
    };
  }

  private isAssignedSe(ticket: TicketRow, actor: RequestActor): boolean {
    return actor.role === 'SERVICE_ENGINEER' && ticket.assignedSeId === actor.userId;
  }

  /** A ticket sitting in the ZM decision queue: flagged unable-to-collect and not yet terminal. */
  private inDecisionQueue(ticket: TicketRow): boolean {
    return ticket.unableToCollectReason != null && !TERMINAL_STATES.has(ticket.status);
  }

  /** Closes the ticket to a terminal status with a classified `closure_type` + full audit fields. */
  private async closeWith(
    ticket: TicketRow,
    toState: TicketStatus,
    closureType: $Enums.ClosureType,
    reason: string,
    actor: RequestActor,
    action: string,
    now: Date = new Date(),
  ): Promise<RecoveryOutcome> {
    const updated = await this.audit.withAudit(
      {
        ...auditActor(actor),
        action,
        entityType: 'tickets',
        entityId: ticket.ticketId,
        metadata: {
          closureType,
          reason,
          previousState: ticket.status,
          deviceSerial: ticket.collectedDeviceSerial ?? String(ticket.deviceId),
        },
      },
      async (tx) => {
        const row = await tx.ticket.update({
          where: { ticketId: ticket.ticketId },
          data: { status: toState, closureType, closureReason: reason, closedAt: now, lastStateChangedAt: now },
        });
        await tx.ticketEvent.create({ data: { ticketId: ticket.ticketId, fromState: ticket.status, toState, reasonCode: closureType, ...eventActor(actor), at: now } });
        return row;
      },
    );
    return { result: 'OK', ticket: toView(updated) };
  }

  /** Applies one status transition inside an audited transaction + appends a ticket_events row. */
  private async transition(
    ticket: TicketRow,
    toState: TicketStatus,
    actor: RequestActor,
    action: string,
    extra: Record<string, unknown>,
    now: Date = new Date(),
  ): Promise<RecoveryOutcome> {
    const updated = await this.audit.withAudit(
      {
        ...auditActor(actor),
        action,
        entityType: 'tickets',
        entityId: ticket.ticketId,
      },
      async (tx) => {
        const row = await tx.ticket.update({
          where: { ticketId: ticket.ticketId },
          data: { status: toState, lastStateChangedAt: now, ...extra },
        });
        await tx.ticketEvent.create({
          data: { ticketId: ticket.ticketId, fromState: ticket.status, toState, ...eventActor(actor), at: now },
        });
        return row;
      },
    );
    return { result: 'OK', ticket: toView(updated) };
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Maps the acting role to its manual-closure classification (CONTEXT §14 closure authority). */
function manualClosureType(role: string): $Enums.ClosureType {
  if (role === 'OPERATIONS_HEAD') return 'OPERATIONS_HEAD_OVERRIDE_CLOSE';
  if (role === 'CENTRAL_SERVICE_MANAGER') return 'CSM_ACTING_CLOSE';
  return 'ZM_MANUAL_CLOSE';
}

/** The actor columns for a `ticket_events` row (bare-uuid actor, role + acted-as proxy). */
function eventActor(actor: RequestActor): { actorId: string | null; actorRole: $Enums.Role; actedAsRole: $Enums.Role | null } {
  return {
    actorId: isUuid(actor.userId) ? actor.userId : null,
    actorRole: actor.role as $Enums.Role,
    actedAsRole: (actor.actedAsRole as $Enums.Role | null) ?? null,
  };
}

function toView(row: {
  ticketId: string;
  status: TicketStatus;
  deviceId: bigint;
  assignedSeId: string | null;
  collectedDeviceSerial: string | null;
  collectionConditionNotes: string | null;
  unableToCollectReason: $Enums.UnableToCollectReason | null;
  closureType: $Enums.ClosureType | null;
  closedAt: Date | null;
}): RecoveryView {
  return {
    ticketId: row.ticketId,
    status: row.status,
    deviceId: row.deviceId,
    assignedSeId: row.assignedSeId,
    collectedDeviceSerial: row.collectedDeviceSerial,
    collectionConditionNotes: row.collectionConditionNotes,
    unableToCollectReason: row.unableToCollectReason,
    closureType: row.closureType,
    closedAt: row.closedAt,
  };
}
