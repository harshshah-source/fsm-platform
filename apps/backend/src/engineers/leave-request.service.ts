import { Injectable } from '@nestjs/common';
import { AuditService, type AuditActorFields } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';
import { type LeaveRequestType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SeAvailabilityService } from './se-availability.service';

export interface LeaveActor {
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

export interface SubmitLeaveInput {
  seId: string;
  type: LeaveRequestType;
  windowStart: Date;
  windowEnd: Date;
  reason?: string | null;
}

export type LeaveOutcome =
  | { result: 'OK'; id: string }
  | { result: 'FORBIDDEN' }
  | { result: 'NOT_FOUND' }
  | { result: 'INVALID_STATE' }
  /** #363 — the window collides with one the SE already holds; `conflictId` is the request holding it. */
  | { result: 'OVERLAP'; conflictId: string };

export interface LeaveRequestRow {
  id: string;
  seId: string;
  seName: string;
  type: LeaveRequestType;
  status: string;
  windowStart: string;
  windowEnd: string;
  reason: string | null;
  decisionReason: string | null;
  createdAt: string;
}

export interface LeaveScope {
  role: string;
  zoneId: number | null;
}

/**
 * Leave Request workflow (Issue 26). An SE files ON_LEAVE / WEEKLY_OFF for a range (PENDING); the
 * own-zone Zonal Manager approves — which writes an `se_availability` window (so the Recommender
 * excludes the SE, AC Issue 25) and links it via `availability_id` — or rejects with a mandatory
 * reason. A rejected request is terminal; the SE revises + resubmits as a new row. Notifications
 * (ZM-on-submit, SE-on-decision) are the Issue 03 seam.
 *
 * #363 closed the three ways this workflow could put an engineer on the board who was not available,
 * or off it when they were: an approval can now be {@link revoke}d, a window an SE already holds
 * refuses a second {@link submit}, and every read of the availability it writes takes the same
 * latest-write-wins order (`SeAvailabilityService`).
 */
@Injectable()
export class LeaveRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: SeAvailabilityService = new SeAvailabilityService(prisma),
    // Defaulted for the same reason `availability` is: this service is constructed directly by
    // several specs, and a required third parameter would break callers that have nothing to do with
    // auditing. Nest injects the module's singleton, so the default is never used at runtime.
    private readonly audit: AuditService = new AuditService(prisma),
  ) {}

  /**
   * The who/where of a leave decision as an audit row wants it. {@link LeaveActor} is the older,
   * looser shape (its acting fields are optional), so the `?? null` normalisation happens here rather
   * than at each call site — `auditActor` takes a `RequestActor` and this is its equivalent.
   */
  private auditFields(actor: LeaveActor): AuditActorFields {
    return {
      actorId: actor.userId,
      actorRole: actor.role,
      actedAsRole: actor.actedAsRole ?? null,
      actingZone: actor.actingZone ?? null,
    };
  }

  /** SE files (or own-zone ZM files on their behalf). */
  async submit(input: SubmitLeaveInput, actor: LeaveActor): Promise<LeaveOutcome> {
    const engineer = await this.prisma.engineerMaster.findUnique({ where: { engineerId: input.seId } });
    if (!engineer) return { result: 'NOT_FOUND' };
    if (!this.canActFor(engineer.zoneId, input.seId, actor)) return { result: 'FORBIDDEN' };

    const clash = await this.overlapping(input);
    if (clash) return { result: 'OVERLAP', conflictId: String(clash.id) };

    const created = await this.prisma.leaveRequest.create({
      data: {
        seId: input.seId,
        type: input.type,
        status: 'PENDING',
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        reason: input.reason ?? null,
      },
    });
    return { result: 'OK', id: String(created.id) };
  }

  /**
   * Own-zone ZM (or CSM acting) approves → write the availability window + mark APPROVED.
   *
   * `now` is threaded rather than read inside because the write it delegates to has a **time-dependent
   * consequence** since #288: approving leave that covers today escalates the engineer's remaining
   * committed work, and approving leave for next month does not. A clock read inside the service
   * would make that difference untestable at a fixed instant.
   */
  async approve(id: string, actor: LeaveActor, now: Date = new Date()): Promise<LeaveOutcome> {
    const req = await this.prisma.leaveRequest.findUnique({
      where: { id: BigInt(id) },
      include: { engineer: true },
    });
    if (!req) return { result: 'NOT_FOUND' };
    if (!this.isManagerFor(req.engineer.zoneId, actor)) return { result: 'FORBIDDEN' };
    if (req.status !== 'PENDING') return { result: 'INVALID_STATE' };

    const avail = await this.availability.setAvailability(
      { seId: req.seId, status: req.type, windowStart: req.windowStart, windowEnd: req.windowEnd, reason: req.reason },
      { userId: actor.userId, role: actor.role, zoneId: actor.zoneId, actedAsRole: actor.actedAsRole ?? null },
      now,
    );
    if (avail.result !== 'OK') return avail.result === 'FORBIDDEN' ? { result: 'FORBIDDEN' } : { result: 'NOT_FOUND' };

    // #343 — the decision and its audit row commit together. `decided_by` alone could not answer the
    // question an operator actually asks ("who took this SE off the board, and under whose duty"):
    // it holds no acting attribution, and the availability window the approval creates was recorded
    // under `SE_AVAILABILITY_SET` with no link back to the request that caused it.
    await this.audit.withAudit(
      {
        ...this.auditFields(actor),
        action: 'LEAVE_APPROVED',
        entityType: 'leave_requests',
        entityId: String(req.id),
        metadata: {
          seId: req.seId,
          type: req.type,
          windowStart: req.windowStart.toISOString(),
          windowEnd: req.windowEnd.toISOString(),
          requestReason: req.reason,
          availabilityId: String(avail.id),
        },
      },
      (tx) =>
        tx.leaveRequest.update({
          where: { id: req.id },
          data: {
            status: 'APPROVED',
            decidedBy: actor.userId.length === 36 ? actor.userId : null,
            decidedByRole: actor.actedAsRole ?? actor.role,
            decidedAt: new Date(),
            availabilityId: BigInt(avail.id),
          },
        }),
    );
    return { result: 'OK', id };
  }

  /** Own-zone ZM rejects with a mandatory reason. */
  async reject(id: string, reason: string, actor: LeaveActor): Promise<LeaveOutcome> {
    const req = await this.prisma.leaveRequest.findUnique({
      where: { id: BigInt(id) },
      include: { engineer: true },
    });
    if (!req) return { result: 'NOT_FOUND' };
    if (!this.isManagerFor(req.engineer.zoneId, actor)) return { result: 'FORBIDDEN' };
    if (req.status !== 'PENDING') return { result: 'INVALID_STATE' };

    // #343 AC2 — a rejection wrote **no** audit row at all, which made the one decision that carries a
    // mandatory reason the one the ledger could not reproduce. The reason is on the row as well as in
    // `decision_reason`: the column is overwritten if the request is ever decided again, the row is not.
    await this.audit.withAudit(
      {
        ...this.auditFields(actor),
        action: 'LEAVE_REJECTED',
        entityType: 'leave_requests',
        entityId: String(req.id),
        metadata: {
          seId: req.seId,
          type: req.type,
          windowStart: req.windowStart.toISOString(),
          windowEnd: req.windowEnd.toISOString(),
          reason,
        },
      },
      (tx) =>
        tx.leaveRequest.update({
          where: { id: req.id },
          data: {
            status: 'REJECTED',
            decisionReason: reason,
            decidedBy: actor.userId.length === 36 ? actor.userId : null,
            decidedByRole: actor.actedAsRole ?? actor.role,
            decidedAt: new Date(),
          },
        }),
    );
    return { result: 'OK', id };
  }

  /**
   * #363 AC2 — undo an approval that should not have happened.
   *
   * The three-line version of the bug: approval was terminal. A ZM who approved the wrong request, or
   * whose SE cancelled their plans, had no way back — the request stayed APPROVED and, far worse, the
   * `se_availability` window it wrote stayed on the board, so an engineer standing in the depot was
   * invisible to the Recommender for the rest of the window and the dispatcher found out when nobody
   * turned up.
   *
   * Revoke **writes an `AVAILABLE` window over exactly the leave's range** rather than deleting the
   * leave window. Two reasons. Availability is append-only everywhere else in this service, and a
   * decision that erases its own evidence is the one an operator can never reconstruct; and the write
   * that gives the day back is then the same kind of row as the write that took it, so it wins by
   * {@link SeAvailabilityService} tie-break (AC1) — same start instant, later id — and the very next
   * Recommender run books the engineer again. Nothing here reassigns work: giving the day back is the
   * decision, redistributing it stays the ZM's (#282 R4).
   *
   * **Revoked is a derived status.** `leave_request_status` has no `REVOKED` member and the schema is
   * owned by another slice this round, so the row stays APPROVED and carries the revocation in
   * `decision_reason` (the same column a rejection uses, and the same mandatory-reason rule). Every
   * read maps it to `REVOKED` via {@link isRevoked}, so no caller has to know that — but the enum
   * member is a follow-up worth taking.
   *
   * The parameter order is {@link reject}'s — `(id, reason, actor)`, the plan wrote `(id, actor,
   * reason)` — because a mandatory-reason decision on this service should read the same way twice.
   */
  async revoke(id: string, reason: string, actor: LeaveActor, now: Date = new Date()): Promise<LeaveOutcome> {
    const req = await this.prisma.leaveRequest.findUnique({
      where: { id: BigInt(id) },
      include: { engineer: true },
    });
    if (!req) return { result: 'NOT_FOUND' };
    if (!this.isManagerFor(req.engineer.zoneId, actor)) return { result: 'FORBIDDEN' };
    // Only an approval holds a day, and only once: a PENDING request has no window to give back and a
    // second revoke is not a second decision.
    if (req.status !== 'APPROVED' || this.isRevoked(req)) return { result: 'INVALID_STATE' };

    const avail = await this.availability.setAvailability(
      { seId: req.seId, status: 'AVAILABLE', windowStart: req.windowStart, windowEnd: req.windowEnd, reason },
      { userId: actor.userId, role: actor.role, zoneId: actor.zoneId, actedAsRole: actor.actedAsRole ?? null },
      now,
    );
    if (avail.result !== 'OK') return avail.result === 'FORBIDDEN' ? { result: 'FORBIDDEN' } : { result: 'NOT_FOUND' };

    // #343's shape, unchanged: the decision and its audit row commit together. Both availability ids
    // are on the row because the question this answers is "who put this engineer back on the day, and
    // which window did that replace" — the revoked window is not deleted, it is superseded.
    await this.audit.withAudit(
      {
        ...this.auditFields(actor),
        action: 'LEAVE_REVOKED',
        entityType: 'leave_requests',
        entityId: String(req.id),
        metadata: {
          seId: req.seId,
          type: req.type,
          windowStart: req.windowStart.toISOString(),
          windowEnd: req.windowEnd.toISOString(),
          reason,
          revokedAvailabilityId: req.availabilityId != null ? String(req.availabilityId) : null,
          availabilityId: String(avail.id),
        },
      },
      (tx) =>
        tx.leaveRequest.update({
          where: { id: req.id },
          data: {
            decisionReason: reason,
            decidedBy: actor.userId.length === 36 ? actor.userId : null,
            decidedByRole: actor.actedAsRole ?? actor.role,
            decidedAt: new Date(),
          },
        }),
    );
    return { result: 'OK', id };
  }

  /**
   * #363 AC3 — does this window collide with a day the SE already holds?
   *
   * `submit` accepted overlapping and duplicate PENDING windows, so the same absence could be filed
   * twice and approved twice: two availability windows and two audit trails for one absence, and a
   * manager reading the queue with no way to tell which row the SE meant. Half-open intervals, so
   * `[10,12)` and `[12,14)` touch without colliding — the same end-exclusive convention the active
   * window predicate and #204's IST day-bounds use.
   *
   * Only **live** rows hold a day: PENDING (awaiting a decision) and APPROVED (holding a window). A
   * REJECTED request holds nothing — blocking on it would refuse the very revision the SE was asked
   * for — and neither does a revoked one, whose day has already been given back.
   */
  private overlapping(input: SubmitLeaveInput) {
    return this.prisma.leaveRequest.findFirst({
      where: {
        seId: input.seId,
        windowStart: { lt: input.windowEnd },
        windowEnd: { gt: input.windowStart },
        OR: [{ status: 'PENDING' }, { status: 'APPROVED', decisionReason: null }],
      },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
  }

  /** An APPROVED request that carries a decision reason has been revoked (see {@link revoke}). */
  private isRevoked(r: { status: string; decisionReason: string | null }): boolean {
    return r.status === 'APPROVED' && r.decisionReason !== null;
  }

  /** Zone-scoped leave requests (ZM own-zone; CSM / Operations Head all), newest first. */
  async listForZone(scope: LeaveScope): Promise<LeaveRequestRow[]> {
    const rows = await this.prisma.leaveRequest.findMany({
      where: scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? { engineer: { zoneId: BigInt(scope.zoneId) } } : {},
      include: { engineer: { include: { user: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => this.toRow(r));
  }

  /** #163 item 2 — `GET /api/me/leave-requests`. Same row shape as {@link listForZone} (including
   *  `decisionReason` — already on the model, previously exposed only behind the manager role), keyed
   *  on the caller's own `seId` instead of zone. Every status, not just PENDING, so the SE can see a
   *  past rejection's reason. */
  async listForSe(seId: string, limit = 200): Promise<LeaveRequestRow[]> {
    const rows = await this.prisma.leaveRequest.findMany({
      where: { seId },
      include: { engineer: { include: { user: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.toRow(r));
  }

  private toRow(
    r: Prisma.LeaveRequestGetPayload<{ include: { engineer: { include: { user: { select: { name: true } } } } } }>,
  ): LeaveRequestRow {
    return {
      id: String(r.id),
      seId: r.seId,
      seName: r.engineer.user.name,
      type: r.type,
      // #363 — `REVOKED` is derived, not stored (see {@link revoke}). Every reader of a leave row gets
      // it, so neither the ZM's queue nor the SE's own list shows approved leave nobody is taking.
      status: this.isRevoked(r) ? 'REVOKED' : r.status,
      windowStart: r.windowStart.toISOString(),
      windowEnd: r.windowEnd.toISOString(),
      reason: r.reason,
      decisionReason: r.decisionReason,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /** Submit authorization: the SE themselves, or a manager over the SE's zone. */
  private canActFor(seZoneId: bigint, seId: string, actor: LeaveActor): boolean {
    if (actor.role === 'SERVICE_ENGINEER') return actor.userId === seId;
    return this.isManagerFor(seZoneId, actor);
  }

  /** ZM over the SE's own zone (zoneId null = unscoped), or CSM acting in scope. */
  private isManagerFor(seZoneId: bigint, actor: LeaveActor): boolean {
    const role = actor.actedAsRole ?? actor.role;
    if (role === 'ZONAL_MANAGER') return actor.zoneId === null || Number(seZoneId) === actor.zoneId;
    return role === 'CENTRAL_SERVICE_MANAGER';
  }
}
