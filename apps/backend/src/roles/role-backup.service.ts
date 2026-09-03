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

/** One `role_unavailability` window as Settings shows it (#339). */
export interface UnavailabilityRow {
  id: string;
  role: string;
  zoneId: string | null;
  zoneName: string | null;
  userId: string | null;
  windowStart: string;
  windowEnd: string | null;
  reason: string | null;
  createdByRole: string | null;
  /** In force at the moment it was read — what the acting gate consults. */
  open: boolean;
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

  /**
   * The unavailability windows, newest first (#339 AC4) — what Settings shows and what an operator
   * ends. `openOnly` narrows to windows in force right now; the default is the full recent history,
   * because "who was covering this zone last week" is the question the audit trail gets asked.
   */
  async listUnavailability(opts: { openOnly?: boolean } = {}, now: Date = new Date()): Promise<UnavailabilityRow[]> {
    const rows = await this.prisma.roleUnavailability.findMany({
      where: opts.openOnly
        ? { windowStart: { lte: now }, OR: [{ windowEnd: null }, { windowEnd: { gt: now } }] }
        : {},
      orderBy: { id: 'desc' },
      take: 200,
    });
    // `role_unavailability.zone_id` carries no FK relation in the schema, so the names come from one
    // extra query over the ids actually present rather than from an `include` — and rather than from
    // a migration this slice has no other reason to write.
    const zoneIds = [...new Set(rows.map((r) => r.zoneId).filter((z): z is bigint => z !== null))];
    const zones = zoneIds.length
      ? await this.prisma.zone.findMany({ where: { zoneId: { in: zoneIds } }, select: { zoneId: true, name: true } })
      : [];
    const nameOf = new Map(zones.map((z) => [String(z.zoneId), z.name]));
    return rows.map((r) => ({
      id: String(r.id),
      role: r.role,
      zoneId: r.zoneId === null ? null : String(r.zoneId),
      // The zone NAME, not just the id: the operator picked "North", and a settings table that says
      // `3` makes them go and look it up (the same defect #339 fixes in the acting banner).
      zoneName: r.zoneId === null ? null : (nameOf.get(String(r.zoneId)) ?? null),
      userId: r.userId,
      windowStart: r.windowStart.toISOString(),
      windowEnd: r.windowEnd?.toISOString() ?? null,
      reason: r.reason,
      createdByRole: r.createdByRole,
      open: r.windowStart <= now && (r.windowEnd === null || r.windowEnd > now),
    }));
  }

  /**
   * End a window **now** (#339 AC4) — never delete it. The cascade reads these by time and the audit
   * trail reads them as history: deleting one would erase the record of who was covering a zone while
   * decisions were being made in it. Ending an already-ended window is a no-op, not an error: the
   * operator's intent ("this cover is over") is already true.
   */
  async endUnavailability(
    id: bigint,
    now: Date = new Date(),
  ): Promise<{ result: 'OK'; role: string; zoneId: string | null } | { result: 'NOT_FOUND' }> {
    const row = await this.prisma.roleUnavailability.findUnique({ where: { id } });
    if (!row) return { result: 'NOT_FOUND' };
    if (row.windowEnd === null || row.windowEnd > now) {
      await this.prisma.roleUnavailability.update({ where: { id }, data: { windowEnd: now } });
    }
    return { result: 'OK', role: row.role, zoneId: row.zoneId === null ? null : String(row.zoneId) };
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
