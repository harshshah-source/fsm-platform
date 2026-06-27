import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Result of one month's ZM Performance Scorecard aggregation run. */
export interface ZmPerformanceAggregationResult {
  month: string; // ISO date of the month's first day
  zms: number; // rows written (one per ZM user)
}

/** The audited ZM override-action types (`BATCH_OVERRIDE_*`) that sum into `overridesTotal`. */
const OVERRIDE_ACTIONS = {
  removals: 'BATCH_OVERRIDE_REMOVE_TICKET',
  deferrals: 'BATCH_OVERRIDE_DEFER_TICKET',
  reorders: 'BATCH_OVERRIDE_REORDER',
  swaps: 'BATCH_OVERRIDE_SWAP_SE',
  reassignments: 'BATCH_OVERRIDE_REASSIGN',
  splitBatches: 'BATCH_OVERRIDE_SPLIT_BATCH',
} as const;
const ONSITE_ACTION = 'OVERRIDE_AFTER_ON_SITE';
/** Manual ZM scheduling interventions: one-click critical assign + same-day manual updates (Issue 31). */
const MANUAL_ACTIONS = ['CRITICAL_ASSIGN', 'MANUAL_ZM_UPDATE'];
const ALL_ACTIONS = [...Object.values(OVERRIDE_ACTIONS), ONSITE_ACTION, ...MANUAL_ACTIONS];

interface AuditCountRow {
  zmId: string;
  action: string;
  count: number;
}
interface ZoneCountRow {
  zoneId: bigint;
  count: number;
}
interface ZoneSlaRow {
  zoneId: bigint;
  eligible: number;
  downtime: bigint;
  window: bigint;
}

/**
 * ZM Performance Scorecard aggregation worker (Issue 43, CONTEXT §ZM Scorecard). `computeMonth` rebuilds
 * `zm_performance_summary_monthly`: one row per (month, zone, ZM user) holding that ZM's audited
 * decision-activity counts (overrides by type + total, override-after-ON_SITE, manual assignments), the
 * zone's auto-assignment denominator (for override rate), and the zone's Fleet-Uptime inputs (for zone SLA
 * compliance). Only **native** ZM actions count (`audit_logs.actor_role = 'ZONAL_MANAGER'`) — backup-cascade
 * (acted-as) actions are another ZM's keystrokes, not the zone ZM's. Every ZM user is represented
 * (zero-filled) so the comparison is complete. On-demand (no scheduler), same posture as Fleet Uptime.
 * Rebuilt per month (delete + insert in one transaction) so recompute is idempotent. Outcome-causality
 * metrics (tickets improved/delayed, manual-vs-auto success, SE-overload causality) need a
 * decision→outcome model and are a filed follow-up.
 */
@Injectable()
export class ZmPerformanceAggregationService {
  constructor(private readonly prisma: PrismaService) {}

  async computeMonth(month: Date, now: Date = new Date()): Promise<ZmPerformanceAggregationResult> {
    const monthStart = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));

    const zmUsers = await this.prisma.user.findMany({
      where: { role: 'ZONAL_MANAGER', zoneId: { not: null } },
      select: { userId: true, zoneId: true },
    });

    const auditCounts = await this.prisma.$queryRaw<AuditCountRow[]>(Prisma.sql`
      SELECT actor_id::text AS "zmId", action, COUNT(*)::int AS count
      FROM audit_logs
      WHERE actor_role = 'ZONAL_MANAGER' AND created_at >= ${monthStart} AND created_at < ${monthEnd}
        AND action IN (${Prisma.join(ALL_ACTIONS)})
      GROUP BY actor_id, action`);

    const denom = await this.prisma.$queryRaw<ZoneCountRow[]>(Prisma.sql`
      SELECT s.zone_id AS "zoneId", COUNT(*)::int AS count
      FROM plant_batch_assignments b
      JOIN work_schedules s ON s.schedule_id = b.schedule_id
      WHERE b.created_at >= ${monthStart} AND b.created_at < ${monthEnd}
      GROUP BY s.zone_id`);

    const sla = await this.prisma.$queryRaw<ZoneSlaRow[]>(Prisma.sql`
      SELECT zone_id AS "zoneId", COUNT(*)::int AS "eligible",
             COALESCE(SUM(downtime_seconds), 0)::bigint AS "downtime",
             COALESCE(SUM(window_seconds), 0)::bigint AS "window"
      FROM device_downtime_summary_monthly
      WHERE month = ${monthStart} AND eligible = true
      GROUP BY zone_id`);

    const byZmAction = new Map(auditCounts.map((r) => [`${r.zmId}|${r.action}`, r.count]));
    const denomByZone = new Map(denom.map((r) => [r.zoneId.toString(), r.count]));
    const slaByZone = new Map(sla.map((r) => [r.zoneId.toString(), r]));

    const rows = zmUsers.map((zm) => {
      const zoneKey = zm.zoneId!.toString();
      const c = (action: string) => byZmAction.get(`${zm.userId}|${action}`) ?? 0;
      const overrides = Object.fromEntries(
        Object.entries(OVERRIDE_ACTIONS).map(([key, action]) => [key, c(action)]),
      ) as Record<keyof typeof OVERRIDE_ACTIONS, number>;
      const overridesTotal = Object.values(overrides).reduce((s, n) => s + n, 0);
      const zoneSla = slaByZone.get(zoneKey);
      return {
        month: monthStart,
        zoneId: zm.zoneId!,
        zmId: zm.userId,
        overridesTotal,
        ...overrides,
        overrideAfterOnsite: c(ONSITE_ACTION),
        manualAssignments: MANUAL_ACTIONS.reduce((s, a) => s + c(a), 0),
        autoAssignedCount: denomByZone.get(zoneKey) ?? 0,
        zoneEligibleDevices: zoneSla?.eligible ?? 0,
        zoneDowntimeSeconds: zoneSla?.downtime ?? 0n,
        zoneWindowSeconds: zoneSla?.window ?? 0n,
        computedAt: now,
      };
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.zmPerformanceSummaryMonthly.deleteMany({ where: { month: monthStart } });
      if (rows.length > 0) await tx.zmPerformanceSummaryMonthly.createMany({ data: rows });
    });

    return { month: monthStart.toISOString().slice(0, 10), zms: rows.length };
  }
}
