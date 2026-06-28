import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditTrailScope {
  role: string;
  zoneId: number | null;
}

/** One entry in a Ticket's audit trail — a state transition (ticket_events) or an audited action (audit_logs). */
export interface AuditTrailEntry {
  at: string;
  kind: 'STATE_CHANGE' | 'ACTION';
  actorId: string | null;
  actorRole: string | null;
  actedAsRole: string | null;
  // STATE_CHANGE
  fromState?: string | null;
  toState?: string;
  reasonCode?: string | null;
  // ACTION
  action?: string;
  actingZone?: string | null;
  metadata?: unknown;
}
export interface TicketAuditTrail {
  ticketId: string;
  entries: AuditTrailEntry[];
}
export type TicketAuditTrailOutcome = { result: 'OK'; trail: TicketAuditTrail } | { result: 'NOT_FOUND' };

/**
 * The user-facing audit-trail viewer (Issue 03). Renders the full chain for a Ticket by merging its
 * `ticket_events` (state transitions: Recommendation → BatchApproved → SEAccepted → OnSite → Closed,
 * retry chains, `closure_type` + reason) with the `audit_logs` actions scoped to that ticket
 * (`entity_type = 'ticket'`), ordered by time. Each entry carries actor, role, and — where applicable —
 * `acted_as_role` (AC#5/#6). A ZONAL_MANAGER sees only tickets in their own zone (out-of-zone → NOT_FOUND);
 * CSM / Operations Head see any ticket.
 */
@Injectable()
export class AuditTrailService {
  constructor(private readonly prisma: PrismaService) {}

  async ticketTrail(ticketId: string, scope: AuditTrailScope): Promise<TicketAuditTrailOutcome> {
    const ticket = await this.prisma.ticket.findUnique({ where: { ticketId }, select: { plant: { select: { zoneId: true } } } });
    if (!ticket) return { result: 'NOT_FOUND' };
    if (scope.role === 'ZONAL_MANAGER' && Number(ticket.plant.zoneId) !== scope.zoneId) return { result: 'NOT_FOUND' };

    const [events, logs] = await Promise.all([
      this.prisma.ticketEvent.findMany({ where: { ticketId }, orderBy: { at: 'asc' } }),
      this.prisma.auditLog.findMany({ where: { entityType: 'ticket', entityId: ticketId }, orderBy: { createdAt: 'asc' } }),
    ]);

    const entries: AuditTrailEntry[] = [
      ...events.map((e): AuditTrailEntry => ({
        at: e.at.toISOString(),
        kind: 'STATE_CHANGE',
        actorId: e.actorId,
        actorRole: e.actorRole,
        actedAsRole: e.actedAsRole,
        fromState: e.fromState,
        toState: e.toState,
        reasonCode: e.reasonCode,
      })),
      ...logs.map((l): AuditTrailEntry => ({
        at: l.createdAt.toISOString(),
        kind: 'ACTION',
        actorId: l.actorId,
        actorRole: l.actorRole,
        actedAsRole: l.actedAsRole,
        action: l.action,
        actingZone: l.actingZone != null ? String(l.actingZone) : null,
        metadata: l.metadata,
      })),
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    return { result: 'OK', trail: { ticketId, entries } };
  }
}
