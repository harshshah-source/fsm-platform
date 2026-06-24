import { Injectable } from '@nestjs/common';
import { type LeaveRequestType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SeAvailabilityService } from './se-availability.service';

export interface LeaveActor {
  userId: string;
  role: string;
  zoneId: number | null;
  actedAsRole?: string | null;
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
  | { result: 'INVALID_STATE' };

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
 */
@Injectable()
export class LeaveRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: SeAvailabilityService = new SeAvailabilityService(prisma),
  ) {}

  /** SE files (or own-zone ZM files on their behalf). */
  async submit(input: SubmitLeaveInput, actor: LeaveActor): Promise<LeaveOutcome> {
    const engineer = await this.prisma.engineerMaster.findUnique({ where: { engineerId: input.seId } });
    if (!engineer) return { result: 'NOT_FOUND' };
    if (!this.canActFor(engineer.zoneId, input.seId, actor)) return { result: 'FORBIDDEN' };

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

  /** Own-zone ZM (or CSM acting) approves → write the availability window + mark APPROVED. */
  async approve(id: string, actor: LeaveActor): Promise<LeaveOutcome> {
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
    );
    if (avail.result !== 'OK') return avail.result === 'FORBIDDEN' ? { result: 'FORBIDDEN' } : { result: 'NOT_FOUND' };

    await this.prisma.leaveRequest.update({
      where: { id: req.id },
      data: {
        status: 'APPROVED',
        decidedBy: actor.userId.length === 36 ? actor.userId : null,
        decidedByRole: actor.actedAsRole ?? actor.role,
        decidedAt: new Date(),
        availabilityId: BigInt(avail.id),
      },
    });
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

    await this.prisma.leaveRequest.update({
      where: { id: req.id },
      data: {
        status: 'REJECTED',
        decisionReason: reason,
        decidedBy: actor.userId.length === 36 ? actor.userId : null,
        decidedByRole: actor.actedAsRole ?? actor.role,
        decidedAt: new Date(),
      },
    });
    return { result: 'OK', id };
  }

  /** Zone-scoped leave requests (ZM own-zone; CSM / Operations Head all), newest first. */
  async listForZone(scope: LeaveScope): Promise<LeaveRequestRow[]> {
    const rows = await this.prisma.leaveRequest.findMany({
      where: scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? { engineer: { zoneId: BigInt(scope.zoneId) } } : {},
      include: { engineer: { include: { user: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => ({
      id: String(r.id),
      seId: r.seId,
      seName: r.engineer.user.name,
      type: r.type,
      status: r.status,
      windowStart: r.windowStart.toISOString(),
      windowEnd: r.windowEnd.toISOString(),
      reason: r.reason,
      decisionReason: r.decisionReason,
      createdAt: r.createdAt.toISOString(),
    }));
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
