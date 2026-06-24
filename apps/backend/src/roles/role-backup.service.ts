import { Injectable } from '@nestjs/common';
import { type Role } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export interface RoleActor {
  userId: string;
  role: string;
  zoneId: number | null;
}

export interface MarkUnavailableInput {
  role: Role;
  zoneId?: number | null;
  userId?: string | null;
  windowStart: Date;
  windowEnd?: Date | null;
  reason?: string | null;
}

export type MarkOutcome = { result: 'OK'; id: string } | { result: 'FORBIDDEN' };

export interface CsmBackupZoneRow {
  zoneId: string;
  csmActions: number;
  totalActedActions: number;
  /** CSM-acted actions as a % of all acted-as-backup actions in the zone for the period (1dp). */
  sharePct: number;
}

/** The acting role currently holding a zone's ZM duty. */
export type ActingRole = 'ZONAL_MANAGER' | 'CENTRAL_SERVICE_MANAGER' | 'OPERATIONS_HEAD';

/**
 * Role backup cascade (Issue 27, CONTEXT.md §15). The strict upward cascade
 * ZONAL_MANAGER → CENTRAL_SERVICE_MANAGER → OPERATIONS_HEAD, resolved from `role_unavailability`
 * windows. Only Operations Head or a CSM may mark a role unavailable; the resolution is a pure read
 * over active windows. Persisting `acted_as_role` onto API calls + audit is the existing acting-context
 * seam (auth/acting-context.ts); this service answers "who currently holds the duty".
 */
@Injectable()
export class RoleBackupService {
  constructor(private readonly prisma: PrismaService) {}

  async markUnavailable(input: MarkUnavailableInput, actor: RoleActor): Promise<MarkOutcome> {
    if (actor.role !== 'OPERATIONS_HEAD' && actor.role !== 'CENTRAL_SERVICE_MANAGER') {
      return { result: 'FORBIDDEN' };
    }
    const created = await this.prisma.roleUnavailability.create({
      data: {
        role: input.role,
        zoneId: input.zoneId != null ? BigInt(input.zoneId) : null,
        userId: input.userId ?? null,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd ?? null,
        reason: input.reason ?? null,
        createdBy: actor.userId.length === 36 ? actor.userId : null,
        createdByRole: actor.role,
      },
    });
    return { result: 'OK', id: String(created.id) };
  }

  /** Whether the given role (zone-scoped for ZONAL_MANAGER; cross-zone otherwise) is out at `now`. */
  async isRoleUnavailable(role: Role, zoneId: number | null, now: Date = new Date()): Promise<boolean> {
    const row = await this.prisma.roleUnavailability.findFirst({
      where: {
        role,
        zoneId: role === 'ZONAL_MANAGER' && zoneId != null ? BigInt(zoneId) : null,
        windowStart: { lte: now },
        OR: [{ windowEnd: null }, { windowEnd: { gt: now } }],
      },
    });
    return row != null;
  }

  /** The acting role holding a zone's ZM duty, cascading up past any unavailable tier. */
  async currentActingRoleForZone(zoneId: number, now: Date = new Date()): Promise<ActingRole> {
    if (!(await this.isRoleUnavailable('ZONAL_MANAGER', zoneId, now))) return 'ZONAL_MANAGER';
    if (!(await this.isRoleUnavailable('CENTRAL_SERVICE_MANAGER', null, now))) return 'CENTRAL_SERVICE_MANAGER';
    return 'OPERATIONS_HEAD';
  }

  /**
   * Per-zone backup activity for a period (default: the current calendar month) — the share of
   * acted-as-backup actions performed by a CSM, so Operations Head can spot zones where ZM backup is
   * becoming routine (AC#5). Attribution is via `audit_logs.acting_zone`, stamped on acted-as flows.
   */
  async csmBackupShareByZone(periodStart: Date, periodEnd: Date): Promise<CsmBackupZoneRow[]> {
    const grouped = await this.prisma.auditLog.groupBy({
      by: ['actingZone', 'actedAsRole'],
      where: { actingZone: { not: null }, createdAt: { gte: periodStart, lt: periodEnd } },
      _count: { _all: true },
    });
    const byZone = new Map<string, { csm: number; total: number }>();
    for (const r of grouped) {
      const z = String(r.actingZone);
      const e = byZone.get(z) ?? { csm: 0, total: 0 };
      e.total += r._count._all;
      if (r.actedAsRole === 'CENTRAL_SERVICE_MANAGER') e.csm += r._count._all;
      byZone.set(z, e);
    }
    return [...byZone.entries()]
      .map(([zoneId, c]) => ({
        zoneId,
        csmActions: c.csm,
        totalActedActions: c.total,
        sharePct: c.total ? Math.round((c.csm / c.total) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.sharePct - a.sharePct);
  }
}
