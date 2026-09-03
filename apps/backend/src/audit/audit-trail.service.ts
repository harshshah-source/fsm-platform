import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
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
 * The `entity_type` spellings that all mean "this row is about a Ticket".
 *
 * #342 — the writers never agreed on one: `'ticket'` (16 call sites), `'tickets'` (15) and `'TICKET'`
 * (1) are all in `src/`. The trail read hard-filtered `'ticket'`, which quietly hid about half the
 * ticket audit rows in the database from the ticket they belong to. Rather than rewrite history (an
 * append-only compliance table) or pick a winner the next writer would ignore, both readers here
 * normalise: `lower(entity_type) IN (...)`.
 */
export const TICKET_ENTITY_TYPES = ['ticket', 'tickets'] as const;

/** One row of the ledger — an `audit_logs` row with its actor and its zone resolved for display. */
export interface AuditLedgerRow {
  /** `audit_logs.id`, as a string: it is a bigint and also the pagination cursor. */
  id: string;
  at: string;
  action: string;
  actorId: string;
  /** Null for the non-user actors the writers use (`'SYSTEM'`, `'CUSTOMER'`). */
  actorName: string | null;
  actorRole: string;
  actedAsRole: string | null;
  actingZoneId: number | null;
  /** The resolved zone this action belongs to — see {@link AuditTrailService.search}. */
  zoneId: number | null;
  zoneName: string | null;
  entityType: string;
  entityId: string;
  metadata: unknown;
}

export interface AuditSearchQuery {
  actorUserId?: string;
  actedAsRole?: string;
  zoneId?: number;
  action?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  /** Opaque keyset cursor — the `id` of the last row of the previous page. */
  cursor?: string;
  /** Already validated by the controller: an integer in 1..200. */
  limit: number;
}

export interface AuditSearchPage {
  rows: AuditLedgerRow[];
  /** Pass back as `cursor` for the next page; null when this is the last page. */
  nextCursor: string | null;
}

/** Raw shape of one ledger row as the SQL below projects it. */
interface LedgerSqlRow {
  id: bigint;
  created_at: Date;
  action: string;
  actor_id: string;
  actor_name: string | null;
  actor_role: string;
  acted_as_role: string | null;
  acting_zone: bigint | null;
  zone_id: bigint | null;
  zone_name: string | null;
  entity_type: string;
  entity_id: string;
  metadata: unknown;
}

/**
 * The user-facing audit-trail reads (Issue 03, widened by #342).
 *
 * {@link ticketTrail} renders the full chain for one Ticket by merging its `ticket_events` (state
 * transitions) with the `audit_logs` actions scoped to it. {@link search} is the ledger: the same
 * rows, reachable by actor / action / entity / zone / time instead of by ticket UUID.
 *
 * Both are zone-clamped for a ZONAL_MANAGER and pan-India for CSM / Operations Head; the scope comes
 * from `@CurrentScope()`, so a CSM acting in a zone is clamped to that zone exactly as its ZM is.
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
      this.prisma.auditLog.findMany({
        // See TICKET_ENTITY_TYPES: `mode: 'insensitive'` catches the one 'TICKET' writer too.
        where: { entityType: { in: [...TICKET_ENTITY_TYPES], mode: 'insensitive' }, entityId: ticketId },
        orderBy: { createdAt: 'asc' },
      }),
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

  /**
   * The audit ledger — "who did what, in whose scope, when", without needing a ticket UUID first.
   *
   * **A row's zone is derived, not stored.** `audit_logs.acting_zone` is written *only* when the actor
   * was exercising backup authority, so clamping a ZM to `acting_zone = their zone` would show them
   * every row except their own. The zone of an action is therefore resolved in three steps, most
   * specific first:
   *
   *   1. `acting_zone` — the zone whose authority was borrowed. Explicit, so it wins.
   *   2. for a ticket row, the zone of the ticket's plant — where the thing acted on lives. This is
   *      what makes a pan-India CSM's action on a zone-1 ticket visible to zone 1's ZM.
   *   3. the actor's own `users.zone_id` — a zoned actor acting in their own scope.
   *
   * A row that resolves to no zone is a genuinely pan-India action (an OH changing a global setting);
   * it stays invisible to a ZM, which is the correct reading of "own zone only".
   *
   * Written as one statement rather than a Prisma `findMany` because step 2 is a join, and because
   * filtering *after* the limit would break the keyset. Every interpolation below is a bound
   * parameter — `Prisma.sql` never inlines a value.
   */
  async search(query: AuditSearchQuery, scope: AuditTrailScope): Promise<AuditSearchPage> {
    const where: Prisma.Sql[] = [];

    if (query.actorUserId) where.push(Prisma.sql`a.actor_id = ${query.actorUserId}`);
    if (query.actedAsRole) where.push(Prisma.sql`a.acted_as_role = ${query.actedAsRole}`);
    if (query.action) where.push(Prisma.sql`a.action = ${query.action}`);
    if (query.entityId) where.push(Prisma.sql`a.entity_id = ${query.entityId}`);
    if (query.entityType) {
      const wanted = (TICKET_ENTITY_TYPES as readonly string[]).includes(query.entityType.toLowerCase())
        ? [...TICKET_ENTITY_TYPES]
        : [query.entityType.toLowerCase()];
      where.push(Prisma.sql`lower(a.entity_type) IN (${Prisma.join(wanted)})`);
    }
    if (query.from) where.push(Prisma.sql`a.created_at >= ${query.from}`);
    if (query.to) where.push(Prisma.sql`a.created_at <= ${query.to}`);

    // The clamp and the caller's own zone filter are two separate predicates on purpose: a ZM asking
    // for another zone gets an empty page rather than a widened one.
    const clampZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    if (clampZone !== null) where.push(Prisma.sql`zr.zone_id = ${BigInt(clampZone)}`);
    if (query.zoneId !== undefined) where.push(Prisma.sql`zr.zone_id = ${BigInt(query.zoneId)}`);

    if (query.cursor) {
      // Row-comparison keyset against the cursor row's own (created_at, id) — exact even when several
      // rows share a timestamp, and it does not depend on the cursor round-tripping a timestamp
      // through millisecond-precision JSON.
      where.push(
        Prisma.sql`(a.created_at, a.id) < ((SELECT c.created_at FROM audit_logs c WHERE c.id = ${BigInt(query.cursor)}), ${BigInt(query.cursor)})`,
      );
    }

    const predicate = where.length > 0 ? Prisma.join(where, ' AND ') : Prisma.sql`TRUE`;
    // One extra row tells us whether a further page exists without a second COUNT query.
    const fetch = query.limit + 1;

    const rows = await this.prisma.$queryRaw<LedgerSqlRow[]>(Prisma.sql`
      SELECT a.id,
             a.created_at,
             a.action,
             a.actor_id,
             u.name AS actor_name,
             a.actor_role,
             a.acted_as_role,
             a.acting_zone,
             zr.zone_id,
             z.name AS zone_name,
             a.entity_type,
             a.entity_id,
             a.metadata
      FROM audit_logs a
      LEFT JOIN users u ON u.user_id::text = a.actor_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(
          a.acting_zone,
          CASE WHEN lower(a.entity_type) IN (${Prisma.join([...TICKET_ENTITY_TYPES])}) THEN
            CASE WHEN a.entity_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
              (SELECT p.zone_id FROM tickets t JOIN plants p ON p.plant_id = t.plant_id WHERE t.ticket_id = a.entity_id::uuid)
            END
          END,
          u.zone_id
        ) AS zone_id
      ) zr
      LEFT JOIN zones z ON z.zone_id = zr.zone_id
      WHERE ${predicate}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${fetch}
    `);

    const page = rows.slice(0, query.limit);
    return {
      rows: page.map((r) => ({
        id: String(r.id),
        at: r.created_at.toISOString(),
        action: r.action,
        actorId: r.actor_id,
        actorName: r.actor_name,
        actorRole: r.actor_role,
        actedAsRole: r.acted_as_role,
        actingZoneId: r.acting_zone === null ? null : Number(r.acting_zone),
        zoneId: r.zone_id === null ? null : Number(r.zone_id),
        zoneName: r.zone_name,
        entityType: r.entity_type,
        entityId: r.entity_id,
        metadata: r.metadata ?? null,
      })),
      nextCursor: rows.length > query.limit && page.length > 0 ? String(page[page.length - 1].id) : null,
    };
  }
}
