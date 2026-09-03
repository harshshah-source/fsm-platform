import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ZmScope } from './zm-schedule-query.service';

/**
 * The Intra-day Queue's `MANUAL_ZM_UPDATE` stream (Issue 31), **reduced to a read by #356**.
 *
 * Issue 31 gave the ZM three same-day writes — add / remove / reorder a stop on an SE's current Day
 * Plan — each re-tagging the Issue 13 override engine's audit action so the change surfaced here.
 * #313 then made `POST /batches/:id/override` the single same-day write surface, and nothing has
 * called these three since: zero references in `apps/admin`, and `dispatch-changes-today.service.ts`
 * says so in its own docstring. They are deleted rather than left standing, per the recorded decision
 * (plan §7, "356 deletion"). A live route with no callers is worse than a missing one — it looks like
 * a supported way in while its validation, its error vocabulary and its audit action quietly drift
 * away from the surface people actually use.
 *
 * What survives is the read. Per the 2026-06-25 decision the queue is a **view over AuditLog** (no new
 * model); Issue 29's CRITICAL-insertion rows live in the parallel `intraday_insertions` ledger and the
 * page merges the two. `MANUAL_ZM_UPDATE` is now a historical action — nothing in this repo writes it
 * any more — and the read still exists because the history it lists is still the record of what
 * managers did to today's plans.
 */
export type IntradayUpdateType = 'ADD' | 'REMOVE' | 'REORDER';

export interface IntradayUpdateRow {
  auditId: string;
  actorId: string;
  actorRole: string;
  updateType: IntradayUpdateType;
  ticketId: string | null;
  seId: string | null;
  createdAt: string;
}

/** #356 — the same paging vocabulary the insertions read takes, so the queue asks both streams alike. */
export interface IntradayUpdateQuery {
  take?: number;
  since?: Date;
  /** The previous page's `nextCursor`: the last audit-log id the caller has already been shown. */
  cursor?: bigint;
}

export interface IntradayUpdatePage {
  rows: IntradayUpdateRow[];
  nextCursor: string | null;
  limit: number;
}

const MANUAL_ZM_UPDATE = 'MANUAL_ZM_UPDATE';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/**
 * How many audit rows one call may examine before giving up and handing back a cursor.
 *
 * A ZM's page cannot be bounded by a `take` on the SQL query, because whether a row belongs to their
 * zone is only knowable *after* it is fetched and its ticket or batch resolved — `audit_logs` carries
 * no zone. So the read scans in chunks and stops on whichever comes first: the page is full, the
 * stream is exhausted, or this many rows have been looked at. The cap is what makes the worst case
 * finite; the cursor is what makes the truncation recoverable rather than a silent loss.
 */
const SCAN_CHUNK = 200;
const MAX_SCAN = 2_000;

function clampPageSize(take: number | undefined): number {
  if (take == null || !Number.isFinite(take)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(take), 1), MAX_PAGE_SIZE);
}

@Injectable()
export class SameDayUpdateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The Intra-day Queue read — MANUAL_ZM_UPDATE audit rows newest-first, zone-scoped: a ZONAL_MANAGER
   * sees only updates in their own zone; cross-zone roles (CSM / Operations Head) see all. ADD rows are
   * ticket-entity (zone via the ticket's plant); REMOVE / REORDER rows are batch-entity (zone via the
   * batch's schedule), carrying the ticket id (REMOVE) or none (REORDER) in metadata.
   *
   * **#356 (absorbing #331 AC2) — bounded.** This loaded *every* `MANUAL_ZM_UPDATE` row ever written,
   * then filtered by zone in memory: an append-only table read in full, on a page a dispatcher reloads
   * all day, growing for the life of the deployment. It now walks the stream newest-first in chunks
   * and stops at the first of a full page, an exhausted stream, or {@link MAX_SCAN} rows examined.
   *
   * Ordering and the cursor both ride `audit_logs.id`. It is the primary key and monotonic with
   * insertion, so `id < cursor` is a keyset that cannot skip or repeat a row — which `createdAt` alone
   * cannot promise, since two rows written in one transaction share it exactly.
   */
  async listIntradayUpdates(scope: ZmScope, query: IntradayUpdateQuery = {}): Promise<IntradayUpdatePage> {
    const limit = clampPageSize(query.take);
    const zmZone = scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? BigInt(scope.zoneId) : null;

    const rows: IntradayUpdateRow[] = [];
    let scanFrom = query.cursor ?? null;
    let scanned = 0;
    /** True when we stopped before the stream ran out, so a next page is worth asking for. */
    let truncated = false;

    while (rows.length < limit && scanned < MAX_SCAN) {
      const logs = await this.prisma.auditLog.findMany({
        where: {
          action: MANUAL_ZM_UPDATE,
          ...(query.since ? { createdAt: { gte: query.since } } : {}),
          ...(scanFrom !== null ? { id: { lt: scanFrom } } : {}),
        },
        orderBy: { id: 'desc' },
        take: SCAN_CHUNK,
      });
      if (logs.length === 0) break;

      const ticketZone = await this.zonesForTickets(logs.filter((l) => l.entityType === 'ticket').map((l) => l.entityId));
      const batchZone = await this.zonesForBatches(
        logs.filter((l) => l.entityType === 'plant_batch_assignment').map((l) => l.entityId),
      );

      for (const l of logs) {
        scanned++;
        // Advanced per row, not per chunk: a page that fills halfway through a chunk must hand back a
        // cursor pointing at the row it stopped on, or the rest of that chunk is lost to the caller.
        scanFrom = l.id;
        const meta = (l.metadata ?? {}) as Record<string, unknown>;
        const zone = l.entityType === 'ticket' ? ticketZone.get(l.entityId) : batchZone.get(l.entityId);
        if (zmZone != null && zone !== zmZone) continue;
        const ticketId =
          l.entityType === 'ticket' ? l.entityId : typeof meta.ticketId === 'string' ? meta.ticketId : null;
        rows.push({
          auditId: String(l.id),
          actorId: l.actorId,
          actorRole: l.actorRole,
          updateType: (meta.updateType as IntradayUpdateType) ?? 'ADD',
          ticketId,
          seId: typeof meta.seId === 'string' ? meta.seId : null,
          createdAt: l.createdAt.toISOString(),
        });
        if (rows.length >= limit) {
          truncated = true;
          break;
        }
      }
      // A short chunk is the end of the stream — nothing left to page to.
      if (logs.length < SCAN_CHUNK) break;
      if (rows.length < limit && scanned >= MAX_SCAN) truncated = true;
    }

    return { rows, nextCursor: truncated && scanFrom !== null ? String(scanFrom) : null, limit };
  }

  private async zonesForTickets(ticketIds: string[]): Promise<Map<string, bigint>> {
    if (ticketIds.length === 0) return new Map();
    const tickets = await this.prisma.ticket.findMany({
      where: { ticketId: { in: [...new Set(ticketIds)] } },
      select: { ticketId: true, plant: { select: { zoneId: true } } },
    });
    return new Map(tickets.map((t) => [t.ticketId, t.plant.zoneId]));
  }

  private async zonesForBatches(batchIds: string[]): Promise<Map<string, bigint>> {
    if (batchIds.length === 0) return new Map();
    const batches = await this.prisma.plantBatchAssignment.findMany({
      where: { batchId: { in: [...new Set(batchIds)].map((id) => BigInt(id)) } },
      select: { batchId: true, schedule: { select: { zoneId: true } } },
    });
    return new Map(batches.map((b) => [String(b.batchId), b.schedule.zoneId]));
  }
}
