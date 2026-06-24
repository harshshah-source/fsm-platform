import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface ZoneOverviewRow {
  zoneId: string;
  zoneName: string;
  totalInactive: number;
  /** Count of inactive devices per SLA bucket. ACTIVE devices (null bucket) never appear. */
  byBucket: Record<string, number>;
  /** Trend % vs previous day — null until the daily-history table lands (Issue 40). */
  trendPctVsPrevDay: number | null;
}

export interface CompanyPlantRow {
  companyId: string;
  companyName: string;
  companyTier: string;
  zoneId: string;
  plantId: string;
  plantName: string;
  totalInactive: number;
  byBucket: Record<string, number>;
}

export interface CriticalQueueTicket {
  ticketId: string;
  deviceId: string;
  slaBucket: string;
  status: string;
}

export interface CriticalQueueGroup {
  companyId: string;
  companyName: string;
  companyTier: string;
  zoneId: string;
  plantId: string;
  plantName: string;
  /** Plant-cluster signal: how many CRITICAL+ tickets sit at this plant (clearable in one visit). */
  clusterSize: number;
  /** Suggested SE options — empty until the Recommender lands (Issue 10). */
  suggestedSes: unknown[];
  tickets: CriticalQueueTicket[];
}

export interface ActionRequiredCard {
  key: string;
  label: string;
  /** 1 = most urgent. Cards render in ascending urgency. */
  urgency: number;
  count: number;
  /** False until the owning issue wires the real source; the UI renders it as a "coming soon" stub. */
  available: boolean;
  /** The issue that lights this card up — documentation only. */
  source: string;
}

/**
 * The Action Required cards in urgency order (Issue 06 "What to build"). Every source is a later
 * issue, so all are stubs (`available:false`, `count:0`) today; each owning issue flips its card on.
 */
const ACTION_REQUIRED_CARDS: ReadonlyArray<Omit<ActionRequiredCard, 'count' | 'available'>> = [
  { key: 'unreviewed_batches', label: 'Auto-dispatched batches awaiting review', urgency: 1, source: 'Issue 11' },
  { key: 'vehicle_unavailability', label: 'Vehicle Unavailability & readiness conflicts', urgency: 2, source: 'Issue 28' },
  { key: 'critical_insertions_awaiting_accept', label: 'CRITICAL insertions awaiting SE Acceptance', urgency: 3, source: 'Issue 29' },
  { key: 'failed_verification', label: 'Failed Verification items', urgency: 4, source: 'Issue 18/19' },
  { key: 'component_blocked', label: 'Component-Blocked Tickets', urgency: 5, source: 'Issue 21' },
  { key: 'waiting_component_overdue', label: 'WAITING_COMPONENT over 7 days', urgency: 6, source: 'Issue 22/23' },
  { key: 'non_op_awaiting_manager', label: 'Non-Op requests awaiting manager confirmation', urgency: 7, source: 'Issue 35' },
  { key: 'manual_assignment_required', label: 'Manual assignment required (retry exhausted)', urgency: 8, source: 'Issue 30' },
];

/** CRITICAL and above, in the SLA severity order (CONTEXT "SLA Bucket"). */
const CRITICAL_PLUS_BUCKETS = [
  'CRITICAL',
  'HIGH_CRITICAL',
  'SEVERE',
  'VERY_SEVERE',
  'LONG_PENDING',
] as const;

interface ZoneScope {
  role: string;
  zoneId: number | null;
}

type GroupedRow = { zoneId: string; zoneName: string; slaBucket: string; count: number };

type CompanyPlantGroupedRow = {
  companyId: string;
  companyName: string;
  companyTier: string;
  zoneId: string;
  plantId: string;
  plantName: string;
  slaBucket: string;
  count: number;
};

/**
 * Dashboard read aggregations (Issue 06). Inline SQL over `device_states` (+ `plants`/`zones`) — the
 * LLD's `mv_zone_dashboard_rollup` materialized view + Redis cache are deferred until that infra is
 * installed (same posture as Issue 04's deferred BullMQ). A ZONAL_MANAGER is scoped to their own
 * zone; CSM / Operations Head see all zones.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async zoneOverview(scope: ZoneScope): Promise<ZoneOverviewRow[]> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const zoneFilter =
      restrictZone !== null ? Prisma.sql`AND z.zone_id = ${BigInt(restrictZone)}` : Prisma.empty;

    const grouped = await this.prisma.$queryRaw<GroupedRow[]>(Prisma.sql`
      SELECT z.zone_id::text AS "zoneId", z.name AS "zoneName",
             ds.sla_bucket::text AS "slaBucket", COUNT(*)::int AS "count"
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      WHERE ds.is_inactive = true AND ds.sla_bucket IS NOT NULL ${zoneFilter}
      GROUP BY z.zone_id, z.name, ds.sla_bucket
      ORDER BY z.zone_id`);

    const byZone = new Map<string, ZoneOverviewRow>();
    for (const r of grouped) {
      let row = byZone.get(r.zoneId);
      if (!row) {
        row = {
          zoneId: r.zoneId,
          zoneName: r.zoneName,
          totalInactive: 0,
          byBucket: {},
          trendPctVsPrevDay: null,
        };
        byZone.set(r.zoneId, row);
      }
      row.byBucket[r.slaBucket] = r.count;
      row.totalInactive += r.count;
    }
    return [...byZone.values()];
  }

  async companyPlantOverview(
    scope: ZoneScope,
    filters: { companyId?: string; plantId?: string } = {},
  ): Promise<CompanyPlantRow[]> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const conds: Prisma.Sql[] = [];
    if (restrictZone !== null) conds.push(Prisma.sql`AND z.zone_id = ${BigInt(restrictZone)}`);
    if (filters.companyId && /^\d+$/.test(filters.companyId))
      conds.push(Prisma.sql`AND c.company_id = ${BigInt(filters.companyId)}`);
    if (filters.plantId && /^\d+$/.test(filters.plantId))
      conds.push(Prisma.sql`AND p.plant_id = ${BigInt(filters.plantId)}`);
    const extra = conds.length ? Prisma.join(conds, ' ') : Prisma.empty;

    const grouped = await this.prisma.$queryRaw<CompanyPlantGroupedRow[]>(Prisma.sql`
      SELECT c.company_id::text AS "companyId", c.name AS "companyName",
             c.company_tier::text AS "companyTier", z.zone_id::text AS "zoneId",
             p.plant_id::text AS "plantId", p.name AS "plantName",
             ds.sla_bucket::text AS "slaBucket", COUNT(*)::int AS "count"
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      JOIN company_master c ON c.company_id = ds.company_id
      WHERE ds.is_inactive = true AND ds.sla_bucket IS NOT NULL ${extra}
      GROUP BY c.company_id, c.name, c.company_tier, z.zone_id, p.plant_id, p.name, ds.sla_bucket
      ORDER BY c.company_tier, c.name, p.name`);

    const byKey = new Map<string, CompanyPlantRow>();
    for (const r of grouped) {
      const key = `${r.companyId}:${r.plantId}`;
      let row = byKey.get(key);
      if (!row) {
        row = {
          companyId: r.companyId,
          companyName: r.companyName,
          companyTier: r.companyTier,
          zoneId: r.zoneId,
          plantId: r.plantId,
          plantName: r.plantName,
          totalInactive: 0,
          byBucket: {},
        };
        byKey.set(key, row);
      }
      row.byBucket[r.slaBucket] = r.count;
      row.totalInactive += r.count;
    }
    return [...byKey.values()];
  }

  async criticalQueue(scope: ZoneScope): Promise<CriticalQueueGroup[]> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const zoneFilter =
      restrictZone !== null ? Prisma.sql`AND z.zone_id = ${BigInt(restrictZone)}` : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{
        ticketId: string;
        deviceId: string;
        status: string;
        slaBucket: string;
        companyId: string;
        companyName: string;
        companyTier: string;
        zoneId: string;
        plantId: string;
        plantName: string;
      }>
    >(Prisma.sql`
      SELECT t.ticket_id::text AS "ticketId", t.device_id::text AS "deviceId",
             t.status::text AS "status", ds.sla_bucket::text AS "slaBucket",
             c.company_id::text AS "companyId", c.name AS "companyName",
             c.company_tier::text AS "companyTier", z.zone_id::text AS "zoneId",
             p.plant_id::text AS "plantId", p.name AS "plantName"
      FROM tickets t
      JOIN device_states ds ON ds.device_id = t.device_id
      JOIN plants p ON p.plant_id = t.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      JOIN company_master c ON c.company_id = t.company_id
      WHERE t.work_type = 'TROUBLESHOOT' AND t.status = 'OPEN'
        AND ds.sla_bucket IN (${Prisma.join([...CRITICAL_PLUS_BUCKETS])}) ${zoneFilter}
      ORDER BY c.company_tier, c.name, p.name`);

    const byKey = new Map<string, CriticalQueueGroup>();
    for (const r of rows) {
      const key = `${r.companyId}:${r.plantId}`;
      let group = byKey.get(key);
      if (!group) {
        group = {
          companyId: r.companyId,
          companyName: r.companyName,
          companyTier: r.companyTier,
          zoneId: r.zoneId,
          plantId: r.plantId,
          plantName: r.plantName,
          clusterSize: 0,
          suggestedSes: [],
          tickets: [],
        };
        byKey.set(key, group);
      }
      group.tickets.push({
        ticketId: r.ticketId,
        deviceId: r.deviceId,
        slaBucket: r.slaBucket,
        status: r.status,
      });
      group.clusterSize = group.tickets.length;
    }
    return [...byKey.values()];
  }

  /**
   * The Action Required panel cards in urgency order. Most sources are later issues and stay graceful
   * stubs (`available:false`, `count:0`); the `waiting_component_overdue` card is wired here (Issue 23)
   * with a real, zone-scoped count of WAITING_COMPONENT cycles paused over 7 days.
   */
  async actionRequired(scope: ZoneScope, now: Date = new Date()): Promise<ActionRequiredCard[]> {
    const waitingComponentOverdue = await this.waitingComponentOverdueCount(scope, now);
    return ACTION_REQUIRED_CARDS.map((c) =>
      c.key === 'waiting_component_overdue'
        ? { ...c, count: waitingComponentOverdue, available: true }
        : { ...c, count: 0, available: false },
    );
  }

  /**
   * Count WAITING_COMPONENT Failure Cycles whose primary SLA has been paused longer than 7 days
   * (CONTEXT §8 auto-escalation). Zone-scoped for a ZM (via the ticket's plant→zone); CSM / Operations
   * Head see all zones.
   */
  private async waitingComponentOverdueCount(scope: ZoneScope, now: Date): Promise<number> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const zoneFilter =
      restrictZone !== null ? Prisma.sql`AND z.zone_id = ${BigInt(restrictZone)}` : Prisma.empty;
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n
      FROM failure_cycles fc
      JOIN tickets t ON t.failure_cycle_id = fc.cycle_id
      JOIN plants p ON p.plant_id = t.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      WHERE fc.state = 'WAITING_COMPONENT' AND fc.sla_paused = true
        AND fc.sla_paused_at < ${cutoff} ${zoneFilter}`);
    return rows[0]?.n ?? 0;
  }
}
