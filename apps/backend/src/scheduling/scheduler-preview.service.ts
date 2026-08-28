import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { istDate, istWindowStart } from '../common/ist-day';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { type ZoneProjection } from '../recommender/recommender.service';
import { DispatchRunService, type DispatchRunError } from './dispatch-run.service';
import { signPreviewToken, verifyPreviewToken } from './preview-token';
import { type ZmScope } from './zm-schedule-query.service';

/**
 * #251 — the admin Scheduler Preview: what the next run *would* do, plus the one pre-run lever an
 * admin has over it.
 *
 * **The shape of the decision this implements (Decision 1/18).** Admin approval is never required.
 * Inaction means the 05:00 run proceeds exactly as if nobody looked — so this service is read-only
 * except for holds, and a hold is not an approval gate: it is a date on a ticket that the existing
 * `notDeferredOn` predicate already respects. Nothing here can block, delay, or alter a run.
 *
 * **Why holds are the only pre-run change.** It is the only one the current data model expresses. A
 * "move this ticket to another SE before the run" would have to invent pre-run assignment state that
 * the run would then have to honour — a second scheduling authority, which is the thing the whole
 * design refuses. `tickets.deferred_until` already exists, is already read by every unassigned-work
 * reader, and needs no new concept.
 *
 * **Why holds need a new writer.** The existing hold writer is `DEFER_TICKET`, which requires a live
 * `batch_assignment_tickets` row — it defers work *off a day plan*. A ticket that has not been
 * dispatched yet has no such row, so an unassigned ticket simply could not be held before now. This
 * is that missing write: a bare, audited `deferred_until` on an OPEN + UNASSIGNED ticket.
 */

/** A hold currently keeping a ticket out of a given day's run. */
export interface HoldInForce {
  ticketId: string;
  /** The date the ticket returns — `notDeferredOn` is inclusive, so it IS dispatchable on this day. */
  heldUntil: string;
  zoneId: string;
  plantName: string;
  deviceId: string | null;
}

export interface SchedulerPreviewResult {
  /** The IST calendar day projected, `YYYY-MM-DD`. */
  targetDate: string;
  zones: ZoneProjection[];
  holds: HoldInForce[];
  /**
   * The oldest recompute watermark across the projected zones — the honest bound on how current the
   * ranking is. Deliberately the **oldest**, not the newest: the caveat has to describe the staleness
   * of the whole picture, and a newest-wins figure would understate it whenever one zone lagged.
   */
  bucketsAsOf: string | null;
  /** Signed snapshot of the per-zone figures shown, for staleness detection on re-poll. */
  previewToken: string;
  /** Zones whose projection failed — surfaced, never silently dropped. */
  errors: DispatchRunError[];
}

/** What the token signs: enough to tell "the world moved" from "the world is as you saw it". */
interface PreviewSnapshot {
  targetDate: string;
  countsByZone: Record<string, { recommended: number; unassignable: number; withheld: number }>;
}

export type StalenessOutcome =
  | { result: 'FRESH' }
  | { result: 'TOKEN_INVALID' }
  | { result: 'TOKEN_STALE'; freshPreview: SchedulerPreviewResult };

export type HoldOutcome =
  | { result: 'OK'; ticketId: string; heldUntil: string }
  | { result: 'NOT_FOUND' }
  /** Assigned tickets are `DEFER_TICKET`'s job — this path would leave the batch row live. */
  | { result: 'NOT_HOLDABLE'; status: string; assignmentState: string }
  /**
   * Decision 13 — a scheduler hold must never silently overwrite a vehicle-return decision. The two
   * are different concepts sharing one column: a hold is an admin's scheduling preference, a return
   * date is an operational fact about a vehicle. Overwriting the second with the first would lose
   * information nobody could recover, so it refuses and shows the return context instead.
   */
  | { result: 'CONFLICT_VEHICLE_UNAVAILABLE'; expectedFrom: string; reportId: string };

export type ReleaseOutcome =
  | { result: 'OK'; ticketId: string }
  | { result: 'NOT_FOUND' }
  | { result: 'NOT_HELD' };

@Injectable()
export class SchedulerPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: DispatchRunService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Project the run for `targetDate`. Writes nothing — the guarantee is #250's, pinned there by
   * whole-table count assertions, and this adds no write of its own.
   */
  async preview(targetDate: Date, scope: ZmScope, now: Date = new Date()): Promise<SchedulerPreviewResult> {
    const day = istDate(targetDate);
    // A ZM sees their own zone only; CSM/OH see every active zone — the codebase's uniform read-scope
    // model (ZM zone-clamped, CSM/OH global), spelled the same way the rest of this controller's
    // services spell it.
    const zoneId = scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? BigInt(scope.zoneId) : undefined;
    const projected = await this.runs.previewActiveZones(day, { zoneId, now });

    const holds = await this.holdsInForce(day, zoneId);
    const countsByZone: PreviewSnapshot['countsByZone'] = {};
    for (const z of projected.zones) {
      countsByZone[z.zoneId] = {
        recommended: z.recommended,
        unassignable: z.unassignable,
        withheld: z.withheldBelowThreshold,
      };
    }

    return {
      targetDate: projected.targetDate,
      zones: projected.zones,
      holds,
      bucketsAsOf: oldestWatermark(projected.zones),
      previewToken: signPreviewToken<PreviewSnapshot>({ targetDate: projected.targetDate, countsByZone }, now),
      errors: projected.errors,
    };
  }

  /**
   * Has the world moved since the operator was shown this token?
   *
   * The scheduler preview never *executes* anything — the 05:00 or manual run is the executor — so
   * unlike bulk-unassign's token this one guards a **display**, not a mutation. Its job is to tell the
   * admin that the plan on their screen is no longer the plan, and hand them the current one.
   */
  async checkStaleness(token: string, scope: ZmScope, now: Date = new Date()): Promise<StalenessOutcome> {
    const decoded = verifyPreviewToken<PreviewSnapshot>(token, now);
    if (!decoded) return { result: 'TOKEN_INVALID' };

    const fresh = await this.preview(istWindowStart(decoded.targetDate), scope, now);
    const current: Record<string, unknown> = {};
    for (const z of fresh.zones) {
      current[z.zoneId] = {
        recommended: z.recommended,
        unassignable: z.unassignable,
        withheld: z.withheldBelowThreshold,
      };
    }
    const same = JSON.stringify(current) === JSON.stringify(decoded.countsByZone);
    return same ? { result: 'FRESH' } : { result: 'TOKEN_STALE', freshPreview: fresh };
  }

  /**
   * Hold an unassigned ticket out of the runs before `heldUntil`.
   *
   * `notDeferredOn` is inclusive on the stored date — a ticket with `deferred_until = D` **is**
   * dispatchable on D. So `heldUntil` reads as "the day it comes back", and holding a ticket off
   * tomorrow means naming the day after. That inclusivity is the shared definition (#146); this
   * writer does not get its own.
   */

  async placeHold(
    ticketId: string,
    heldUntil: Date,
    reasonCode: string,
    scope: ZmScope,
    actor: { userId: string; role: string; actedAsRole?: string | null },
    opts: { confirm?: boolean } = {},
  ): Promise<HoldOutcome> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { ticketId },
      include: { plant: { select: { zoneId: true } } },
    });
    if (!ticket || !this.inScope(ticket.plant.zoneId, scope)) return { result: 'NOT_FOUND' };

    // Holds are a *pre-run* lever. A dispatched ticket has a live batch row that this write would not
    // touch, leaving it on the SE's day plan while marked deferred — the exact split-brain state
    // `DEFER_TICKET` exists to avoid by doing both halves together.
    if (ticket.status !== 'OPEN' || ticket.assignmentState !== 'UNASSIGNED') {
      return { result: 'NOT_HOLDABLE', status: ticket.status, assignmentState: ticket.assignmentState };
    }

    const openReport = await this.prisma.vehicleUnavailabilityReport.findFirst({
      where: { ticketId, status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, expectedFrom: true },
    });
    if (openReport && opts.confirm !== true) {
      return {
        result: 'CONFLICT_VEHICLE_UNAVAILABLE',
        expectedFrom: openReport.expectedFrom.toISOString(),
        reportId: String(openReport.id),
      };
    }

    const day = istDate(heldUntil);
    await this.audit.withAudit(
      {
        actorId: actor.userId,
        actorRole: actor.role,
        actedAsRole: actor.actedAsRole ?? null,
        action: 'SCHEDULER_HOLD_PLACED',
        entityType: 'ticket',
        entityId: ticketId,
        metadata: {
          heldUntil: day.toISOString().slice(0, 10),
          reasonCode,
          previousDeferredUntil: ticket.deferredUntil?.toISOString().slice(0, 10) ?? null,
          // Recorded when set: an override of a vehicle-return date is the one case where this write
          // destroys information, so the trail has to say it happened and who accepted it.
          overrodeVehicleReport: openReport ? String(openReport.id) : null,
        } as Prisma.InputJsonValue,
      },
      async (tx) => {
        await tx.ticket.update({ where: { ticketId }, data: { deferredUntil: day } });
      },
    );

    return { result: 'OK', ticketId, heldUntil: day.toISOString().slice(0, 10) };
  }

  /** Release a hold — the ticket re-enters the very next run. */
  async releaseHold(
    ticketId: string,
    scope: ZmScope,
    actor: { userId: string; role: string; actedAsRole?: string | null },
  ): Promise<ReleaseOutcome> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { ticketId },
      include: { plant: { select: { zoneId: true } } },
    });
    if (!ticket || !this.inScope(ticket.plant.zoneId, scope)) return { result: 'NOT_FOUND' };
    if (ticket.deferredUntil === null) return { result: 'NOT_HELD' };

    await this.audit.withAudit(
      {
        actorId: actor.userId,
        actorRole: actor.role,
        actedAsRole: actor.actedAsRole ?? null,
        action: 'SCHEDULER_HOLD_RELEASED',
        entityType: 'ticket',
        entityId: ticketId,
        metadata: { releasedFrom: ticket.deferredUntil.toISOString().slice(0, 10) } as Prisma.InputJsonValue,
      },
      async (tx) => {
        await tx.ticket.update({ where: { ticketId }, data: { deferredUntil: null } });
      },
    );

    return { result: 'OK', ticketId };
  }

  /**
   * Tickets a deferral keeps out of `day`'s run — the exact complement of `notDeferredOn(day)`, which
   * admits `deferred_until <= day`. Spelled as the negation of the shared predicate's semantics rather
   * than re-deriving a boundary, because an off-by-one here would show the admin holds that are not
   * holding anything (or hide ones that are).
   */
  private async holdsInForce(day: Date, zoneId?: bigint): Promise<HoldInForce[]> {
    const rows = await this.prisma.ticket.findMany({
      where: {
        status: 'OPEN',
        assignmentState: 'UNASSIGNED',
        deferredUntil: { gt: day },
        ...(zoneId != null ? { plant: { zoneId } } : {}),
      },
      select: {
        ticketId: true,
        deferredUntil: true,
        deviceId: true,
        plant: { select: { zoneId: true, name: true } },
      },
      orderBy: { deferredUntil: 'asc' },
    });
    return rows.map((r) => ({
      ticketId: r.ticketId,
      heldUntil: r.deferredUntil!.toISOString().slice(0, 10),
      zoneId: String(r.plant.zoneId),
      plantName: r.plant.name,
      deviceId: r.deviceId,
    }));
  }

  /** ZM is clamped to their own zone; CSM/OH are global — the codebase's uniform read-scope model. */
  private inScope(zoneId: bigint, scope: ZmScope): boolean {
    if (scope.role !== 'ZONAL_MANAGER') return true;
    return scope.zoneId != null && BigInt(scope.zoneId) === zoneId;
  }
}

/** The oldest (most stale) watermark across zones — see {@link SchedulerPreviewResult.bucketsAsOf}. */
function oldestWatermark(zones: ZoneProjection[]): string | null {
  const stamps = zones.map((z) => z.bucketsAsOf).filter((s): s is string => s !== null);
  return stamps.length === 0 ? null : stamps.reduce((a, b) => (a < b ? a : b));
}
