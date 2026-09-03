import { Injectable, Optional } from '@nestjs/common';
import { istDayStartInstant } from '../common/ist-day';
import { type SeAvailabilityStatus } from '../generated/prisma/enums';
import { StrandedWorkEscalationService } from '../intraday/stranded-work-escalation.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SE planning availability (ADR-0010, CONTEXT §SE Availability, Issue 25). Writes time-windowed
 * availability rows and derives the current status (the active window's status, else AVAILABLE) — the
 * value the Recommender Hard Filter and the derived Activity Status consume. Only the Zonal Manager
 * (own-zone) or the SE themselves may write; Operations Head has no role here.
 */
export interface SetAvailabilityInput {
  seId: string;
  status: SeAvailabilityStatus;
  windowStart: Date;
  windowEnd?: Date | null;
  reason?: string | null;
}

export interface AvailabilityActor {
  userId: string;
  role: string;
  zoneId: number | null;
  actedAsRole?: string | null;
  /**
   * The zone whose ZM duty this write is being made under, when the caller is acting (#340).
   * Attribution, not scope: it names who was covering, never what the caller may touch.
   */
  actingZone?: number | null;
}

export type SetAvailabilityOutcome = { result: 'OK'; id: string } | { result: 'FORBIDDEN' } | { result: 'NOT_FOUND' };

/** One `SeAvailability` window, as rendered on `EngineerDetail.availabilityRows` (manager) and
 *  `GET /api/me/availability` (#163 item 7, SE-own). */
export interface AvailabilityRow {
  status: string;
  windowStart: string;
  windowEnd: string | null;
  reason: string | null;
  setByRole: string | null;
}

@Injectable()
export class SeAvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    /**
     * #288 — the escalate-only response to an engineer becoming unavailable with work still on their
     * day.
     *
     * `@Optional()` **with a real default**, the shape `NotificationService`'s channel gateway uses:
     * this service is provided in four modules that do not provide the escalator, and a required
     * dependency would take all four down at boot. The default is a working instance, never a no-op —
     * a dependency that silently does nothing when unwired is a recovery path nothing exercises, which
     * is the class of bug #286 found in `reapStaleDispatchRuns`.
     */
    @Optional()
    private readonly stranded: StrandedWorkEscalationService = new StrandedWorkEscalationService(prisma),
  ) {}

  /** The SE's current planning status: the active window's status (else AVAILABLE). */
  async currentStatus(seId: string, now: Date = new Date()): Promise<SeAvailabilityStatus> {
    const row = await this.prisma.seAvailability.findFirst({
      where: { seId, windowStart: { lte: now }, OR: [{ windowEnd: null }, { windowEnd: { gt: now } }] },
      orderBy: { windowStart: 'desc' },
    });
    return row?.status ?? 'AVAILABLE';
  }

  /** #163 item 7 — `GET /api/me/availability`. The caller's own windows (status/start/end/reason/
   *  setByRole) — #87's AC ("current availability state + active window shown") is unbuildable today
   *  because only the manager `GET /engineers/:seId` read exposes `availabilityRows`. Same shape,
   *  same 10-row bound, keyed on `seId` instead of manager zone-scope. */
  async listWindows(seId: string, limit = 10): Promise<AvailabilityRow[]> {
    const rows = await this.prisma.seAvailability.findMany({
      where: { seId },
      orderBy: { windowStart: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({
      status: r.status,
      windowStart: r.windowStart.toISOString(),
      windowEnd: r.windowEnd ? r.windowEnd.toISOString() : null,
      reason: r.reason,
      setByRole: r.setByRole,
    }));
  }

  /** Current status for a set of SEs in one query (for the Recommender / SE list). */
  async currentStatusMany(seIds: string[], now: Date = new Date()): Promise<Map<string, SeAvailabilityStatus>> {
    const rows = await this.prisma.seAvailability.findMany({
      where: { seId: { in: seIds }, windowStart: { lte: now }, OR: [{ windowEnd: null }, { windowEnd: { gt: now } }] },
      orderBy: { windowStart: 'desc' },
    });
    const out = new Map<string, SeAvailabilityStatus>();
    for (const r of rows) if (!out.has(r.seId)) out.set(r.seId, r.status); // first = latest windowStart
    return out;
  }

  /**
   * Write an availability window. Authorised only for the SE themselves or a Zonal Manager over their
   * own zone (a CSM acting as ZM is treated as ZM). Operations Head is never a setter (CONTEXT).
   *
   * #162 — an SE self-set is narrowed to SOFT_UNAVAILABLE only (PRD:496; workflow:1338/:1360-1363: SE
   * cannot self-approve ON_LEAVE/OFF_SHIFT/WEEKLY_OFF, those are ZM-only). Managers keep the full
   * `SETTABLE_STATUSES` set regardless of which status they're writing.
   *
   * #87/#162 (coupled, operator-settled 2026-07-28) — an SE may also self-set `AVAILABLE`, but only
   * to clear their own currently-active `SOFT_UNAVAILABLE` window early (an open-ended
   * `SOFT_UNAVAILABLE` is otherwise unrecoverable via this API by any role). Checked against
   * whatever status is active *right now*, regardless of who set it — the narrowing this pairs with
   * is specifically about ON_LEAVE/OFF_SHIFT/WEEKLY_OFF (ZM-only decisions), not about who last
   * touched a SOFT_UNAVAILABLE row, which an SE already has full self-service authority over.
   *
   * **#288 — this write has a consequence beyond planning.** A window that takes the engineer off
   * today's remaining field day escalates the work still committed to them, so a ZM is told rather
   * than finding an unworked plan at 18:00. Nothing is reassigned (#282 R4, escalate-only); see
   * {@link strandsWork} for exactly which windows count, and `StrandedWorkEscalationService` for what
   * is raised.
   */
  async setAvailability(
    input: SetAvailabilityInput,
    actor: AvailabilityActor,
    now: Date = new Date(),
  ): Promise<SetAvailabilityOutcome> {
    const engineer = await this.prisma.engineerMaster.findUnique({ where: { engineerId: input.seId } });
    if (!engineer) return { result: 'NOT_FOUND' };

    const effectiveRole = actor.actedAsRole ?? actor.role;
    const selfSet = actor.role === 'SERVICE_ENGINEER' && actor.userId === input.seId;
    const selfClearAllowed = selfSet && input.status === 'AVAILABLE' && (await this.currentStatus(input.seId)) === 'SOFT_UNAVAILABLE';
    const allowed =
      (selfSet && input.status === 'SOFT_UNAVAILABLE') ||
      selfClearAllowed ||
      (effectiveRole === 'ZONAL_MANAGER' && (actor.zoneId === null || Number(engineer.zoneId) === actor.zoneId)) ||
      effectiveRole === 'CENTRAL_SERVICE_MANAGER';
    if (!allowed) return { result: 'FORBIDDEN' };

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.seAvailability.create({
        data: {
          seId: input.seId,
          status: input.status,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd ?? null,
          reason: input.reason ?? null,
          setBy: actor.userId.length === 36 ? actor.userId : null,
          setByRole: actor.actedAsRole ?? actor.role,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          actorRole: actor.role,
          actedAsRole: actor.actedAsRole ?? null,
          actingZone: actor.actingZone != null ? BigInt(actor.actingZone) : null,
          action: 'SE_AVAILABILITY_SET',
          entityType: 'se_availability',
          entityId: String(row.id),
          metadata: { seId: input.seId, status: input.status },
        },
      });
      return row;
    });

    // #288 — outside the transaction on purpose. The availability window is the decision; the
    // escalations are a consequence of it, and a failure to raise them must not roll back the fact
    // that the engineer is unavailable. The same posture `IntradayInsertionService.escalate` holds.
    if (this.strandsWork(input, created.windowStart, now)) await this.stranded.escalateStrandedWork(input.seId, now);

    return { result: 'OK', id: String(created.id) };
  }

  /**
   * Does this window take the engineer off **today's remaining** field day?
   *
   * Three things it is deliberately not. It is not "the status is not AVAILABLE" alone: leave approved
   * on Monday for Friday strands nothing today, and escalating Friday's plan on Monday would put work
   * in the ZM's queue that nobody can act on yet. It is not "the window contains right now" either — a
   * window starting at 14:00 today still takes the afternoon's stops away, and waiting until 14:00 to
   * say so wastes the hours in which the day could have been redistributed. And a window that has
   * already **ended** strands nothing: the engineer is back.
   *
   * So: the window overlaps `[now, end of the IST operating day]`. `AVAILABLE` is excluded because it
   * is the clearing status — the one write here that gives an engineer back to the day rather than
   * taking them from it. `availabilityStatus === 'AVAILABLE'` is the same test
   * `candidate-readiness.ts` makes, and for the same reason: one definition of unavailable.
   */
  private strandsWork(input: SetAvailabilityInput, windowStart: Date, now: Date): boolean {
    if (input.status === 'AVAILABLE') return false;
    const dayEnd = new Date(istDayStartInstant(now).getTime() + 24 * 60 * 60_000);
    const endsAfterNow = input.windowEnd == null || input.windowEnd > now;
    return windowStart < dayEnd && endsAfterNow;
  }
}
