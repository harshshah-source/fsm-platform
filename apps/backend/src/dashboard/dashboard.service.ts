import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Devices on a deactivated plant (Issue 119) drop out of every dashboard count + SLA bucket; they are
 *  surfaced instead on the OH "Plant Deactivations" list. Self-contained predicate — appended to any
 *  aggregation joined to `plants p`. */
const EXCLUDE_DEACTIVATED_PLANTS = Prisma.sql`AND p.plant_id NOT IN (SELECT plant_id FROM plant_deactivations WHERE reactivated_at IS NULL)`;

export interface ZoneOverviewRow {
  zoneId: string;
  zoneName: string;
  /** The zone's Zonal Manager display name (`zones.zonal_manager_user_id` → `users.name`); null if unset. */
  zonalManagerName: string | null;
  totalInactive: number;
  /** All devices (active + inactive) whose plant is in this zone — the denominator for `inactive / total`. */
  totalDevices: number;
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
  /** All devices (active + inactive) at this plant for this company — the denominator for `inactive / total`. */
  totalDevices: number;
  byBucket: Record<string, number>;
}

export interface CriticalQueueTicket {
  ticketId: string;
  deviceId: string;
  slaBucket: string;
  /** Device's last GPS ping (Issue 3) — the UI derives the elapsed inactive duration. */
  latestGpsDatetime: string | null;
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

/** Headline fleet counts for the dashboard KPI strip (Issue 122b): companies / plants / devices in scope. */
export interface FleetSummary {
  companies: number;
  plants: number;
  devices: number;
}

/** One company in the Fleet Directory (Issue 122b KPI click-through). */
export interface FleetDirectoryCompany {
  companyId: string;
  name: string;
  tier: string | null;
  plantCount: number;
  deviceCount: number;
}

/** One plant in the Fleet Directory. */
export interface FleetDirectoryPlant {
  plantId: string;
  name: string;
  companyId: string | null;
  companyName: string | null;
  zoneName: string | null;
  deviceCount: number;
}

export interface FleetDirectory {
  companies: FleetDirectoryCompany[];
  plants: FleetDirectoryPlant[];
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
  { key: 'recovery_stalled', label: 'Recovery Tickets stalled 14+ days', urgency: 9, source: 'Issue 37' },
];

/** Days without state progression after which a Recovery Ticket is "stalled" (Issue 37). */
const RECOVERY_STALL_DAYS = 14;

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

/** Fleet-activity trend ranges (Issue 134). MAX = all history we have. */
export type ActivityTrendRange = '1D' | '7D' | '1M' | '1Y' | 'MAX';
/** Bucket granularity chosen per range so the point count stays bounded. */
export type ActivityTrendBucket = 'hour' | 'day' | 'month';

export interface ActivityTrendPoint {
  /** UTC-truncated bucket start, `YYYY-MM-DD HH:MM:SS` (matches Postgres `timestamp::text`). */
  bucket: string;
  /** Inactive-device stock (eligible-inactive) — the last snapshot in the bucket, or the live count
   *  for the current bucket; null when neither exists (no history yet — the sparse-data case). */
  inactive: number | null;
  /** TROUBLESHOOT tickets CREATED in the bucket (flow). */
  troubleshoot: number;
  /** INSTALL tickets CREATED in the bucket (flow). */
  installation: number;
}

export interface ActivityTrendReport {
  range: ActivityTrendRange;
  from: string;
  to: string;
  bucket: ActivityTrendBucket;
  /** Resolved scope: a ZM's own zone, an OH/CSM's requested zone, or null for pan-India. */
  zoneId: number | null;
  points: ActivityTrendPoint[];
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
      WHERE ds.is_inactive = true AND ds.sla_bucket IS NOT NULL ${zoneFilter} ${EXCLUDE_DEACTIVATED_PLANTS}
      GROUP BY z.zone_id, z.name, ds.sla_bucket
      ORDER BY z.zone_id`);

    // Total devices (active + inactive) per zone — the `inactive / total` denominator (Issue 2). Same
    // zone scope as the inactive aggregation; only zones already surfaced (≥1 inactive device) read it.
    const totals = await this.prisma.$queryRaw<{ zoneId: string; total: number }[]>(Prisma.sql`
      SELECT z.zone_id::text AS "zoneId", COUNT(*)::int AS "total"
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      WHERE true ${zoneFilter} ${EXCLUDE_DEACTIVATED_PLANTS}
      GROUP BY z.zone_id`);
    const totalByZone = new Map(totals.map((t) => [t.zoneId, t.total]));

    // Zonal Manager display name per zone (Issue 122 scorecard column) — tiny unconditional read.
    const zms = await this.prisma.$queryRaw<{ zoneId: string; zmName: string | null }[]>(Prisma.sql`
      SELECT z.zone_id::text AS "zoneId", u.name AS "zmName"
      FROM zones z LEFT JOIN users u ON u.user_id = z.zonal_manager_user_id`);
    const zmByZone = new Map(zms.map((z) => [z.zoneId, z.zmName]));

    const byZone = new Map<string, ZoneOverviewRow>();
    for (const r of grouped) {
      let row = byZone.get(r.zoneId);
      if (!row) {
        row = {
          zoneId: r.zoneId,
          zoneName: r.zoneName,
          zonalManagerName: zmByZone.get(r.zoneId) ?? null,
          totalInactive: 0,
          totalDevices: totalByZone.get(r.zoneId) ?? 0,
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

  /**
   * Headline fleet counts (Issue 122b KPI cards): distinct companies, distinct plants, and tracked
   * devices in the caller's scope. Derived from `device_states` (the tracked fleet — consistent with
   * every other dashboard read), same ZM zone scoping, deactivated plants excluded.
   */
  async fleetSummary(scope: ZoneScope): Promise<FleetSummary> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const zoneFilter =
      restrictZone !== null ? Prisma.sql`AND p.zone_id = ${BigInt(restrictZone)}` : Prisma.empty;

    const rows = await this.prisma.$queryRaw<{ companies: number; plants: number; devices: number }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT ds.company_id)::int AS "companies",
             COUNT(DISTINCT ds.plant_id)::int AS "plants",
             COUNT(*)::int AS "devices"
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      WHERE true ${zoneFilter} ${EXCLUDE_DEACTIVATED_PLANTS}`);
    return rows[0] ?? { companies: 0, plants: 0, devices: 0 };
  }

  /**
   * The Fleet Directory (Issue 122b — the Companies/Plants KPI cards' click-through): every company
   * and plant in the caller's scope BY NAME, with plant/device counts. Same population as
   * {@link fleetSummary} (tracked devices, ZM zone-scoped, deactivated plants excluded), so the
   * directory row counts always reconcile with the KPI numbers.
   */
  async fleetDirectory(scope: ZoneScope): Promise<FleetDirectory> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const zoneFilter =
      restrictZone !== null ? Prisma.sql`AND z.zone_id = ${BigInt(restrictZone)}` : Prisma.empty;

    const companies = await this.prisma.$queryRaw<
      Array<{ companyId: string; name: string; tier: string | null; plantCount: number; deviceCount: number }>
    >(Prisma.sql`
      SELECT c.company_id::text AS "companyId", c.name AS "name", c.company_tier::text AS "tier",
             COUNT(DISTINCT ds.plant_id)::int AS "plantCount", COUNT(*)::int AS "deviceCount"
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      JOIN company_master c ON c.company_id = ds.company_id
      WHERE true ${zoneFilter} ${EXCLUDE_DEACTIVATED_PLANTS}
      GROUP BY c.company_id, c.name, c.company_tier
      ORDER BY "deviceCount" DESC`);

    const plants = await this.prisma.$queryRaw<
      Array<{ plantId: string; name: string; companyId: string | null; companyName: string | null; zoneName: string | null; deviceCount: number }>
    >(Prisma.sql`
      SELECT p.plant_id::text AS "plantId", p.name AS "name",
             c.company_id::text AS "companyId", c.name AS "companyName",
             z.name AS "zoneName", COUNT(*)::int AS "deviceCount"
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      LEFT JOIN company_master c ON c.company_id = ds.company_id
      WHERE true ${zoneFilter} ${EXCLUDE_DEACTIVATED_PLANTS}
      GROUP BY p.plant_id, p.name, c.company_id, c.name, z.name
      ORDER BY "deviceCount" DESC`);

    return { companies, plants };
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
      WHERE ds.is_inactive = true AND ds.sla_bucket IS NOT NULL ${extra} ${EXCLUDE_DEACTIVATED_PLANTS}
      GROUP BY c.company_id, c.name, c.company_tier, z.zone_id, p.plant_id, p.name, ds.sla_bucket
      ORDER BY c.company_tier, c.name, p.name`);

    // Total devices (active + inactive) per company×plant — the `inactive / total` denominator (Issue 2).
    // Reuses the exact same scope filters (`extra`) as the inactive aggregation above.
    const totals = await this.prisma.$queryRaw<{ companyId: string; plantId: string; total: number }[]>(Prisma.sql`
      SELECT c.company_id::text AS "companyId", p.plant_id::text AS "plantId", COUNT(*)::int AS "total"
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      JOIN company_master c ON c.company_id = ds.company_id
      WHERE true ${extra} ${EXCLUDE_DEACTIVATED_PLANTS}
      GROUP BY c.company_id, p.plant_id`);
    const totalByKey = new Map(totals.map((t) => [`${t.companyId}:${t.plantId}`, t.total]));

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
          totalDevices: totalByKey.get(key) ?? 0,
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
        latestGpsDatetime: Date | null;
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
             ds.latest_gps_datetime AS "latestGpsDatetime",
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
        latestGpsDatetime: r.latestGpsDatetime ? r.latestGpsDatetime.toISOString() : null,
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
    const recoveryStalled = await this.recoveryStalledCount(scope, now);
    return ACTION_REQUIRED_CARDS.map((c) => {
      if (c.key === 'waiting_component_overdue') return { ...c, count: waitingComponentOverdue, available: true };
      if (c.key === 'recovery_stalled') return { ...c, count: recoveryStalled, available: true };
      return { ...c, count: 0, available: false };
    });
  }

  /**
   * Count RECOVERY Tickets with no state progression for 14+ days (Issue 37 AC#5). Zone-scoped for a
   * ZM (via the ticket's plant→zone); CSM / Operations Head see all zones.
   */
  private async recoveryStalledCount(scope: ZoneScope, now: Date): Promise<number> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const zoneFilter =
      restrictZone !== null ? Prisma.sql`AND z.zone_id = ${BigInt(restrictZone)}` : Prisma.empty;
    const cutoff = new Date(now.getTime() - RECOVERY_STALL_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n
      FROM tickets t
      JOIN plants p ON p.plant_id = t.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      WHERE t.work_type = 'RECOVERY' AND t.status NOT IN ('CLOSED', 'FAILED_RECOVERY')
        AND t.last_state_changed_at < ${cutoff} ${zoneFilter}`);
    return rows[0]?.n ?? 0;
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

  /**
   * Fleet-activity trend (Issue 134): three time series — inactive-device stock, TROUBLESHOOT tickets
   * created, INSTALL tickets created — bucketed by hour/day/month over the requested range. A ZM is
   * clamped to their own zone; an OH/CSM may pass `zoneId` (zone-wise) or omit it (pan-India). The
   * inactive series reads `soft_inactive_count_history` (twice-daily snapshots), topping the current
   * bucket up with the live count; troubleshoot/installation are grouped over `tickets.created_at`.
   * Buckets with no ticket activity read 0; buckets with no inactive snapshot read null (sparse data).
   */
  async activityTrend(
    scope: ZoneScope,
    opts: { range: ActivityTrendRange; zoneId: number | null },
    now: Date = new Date(),
  ): Promise<ActivityTrendReport> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : opts.zoneId;
    const unit = bucketForRange(opts.range);
    const unitLit = Prisma.raw(`'${unit}'`); // whitelist-derived; safe to inline (must match DISTINCT ON)

    const ticketZone = restrictZone !== null ? Prisma.sql`AND z.zone_id = ${BigInt(restrictZone)}` : Prisma.empty;
    const histZone = restrictZone !== null ? Prisma.sql`AND h.zone_id = ${BigInt(restrictZone)}` : Prisma.empty;
    const dsZone = restrictZone !== null ? Prisma.sql`AND p.zone_id = ${BigInt(restrictZone)}` : Prisma.empty;

    const from =
      opts.range === 'MAX'
        ? (await this.earliestActivity(ticketZone, histZone)) ?? windowStart('1Y', now)
        : windowStart(opts.range, now);

    // TROUBLESHOOT / INSTALL tickets created per bucket.
    const ticketRows = await this.prisma.$queryRaw<{ bucket: string; workType: string; count: number }[]>(Prisma.sql`
      SELECT date_trunc(${unitLit}, t.created_at AT TIME ZONE 'UTC')::text AS "bucket",
             t.work_type::text AS "workType", COUNT(*)::int AS "count"
      FROM tickets t
      JOIN plants p ON p.plant_id = t.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      WHERE t.created_at >= ${from} AND t.work_type IN ('TROUBLESHOOT', 'INSTALL')
        ${ticketZone} ${EXCLUDE_DEACTIVATED_PLANTS}
      GROUP BY 1, t.work_type`);

    // Inactive stock: the last snapshot per zone per bucket, summed across the zones in scope.
    const histRows = await this.prisma.$queryRaw<{ bucket: string; inactive: number }[]>(Prisma.sql`
      WITH snap AS (
        SELECT DISTINCT ON (h.zone_id, date_trunc(${unitLit}, h.captured_at AT TIME ZONE 'UTC'))
               date_trunc(${unitLit}, h.captured_at AT TIME ZONE 'UTC') AS b,
               h.zone_id, h.soft_inactive_count AS cnt
        FROM soft_inactive_count_history h
        WHERE h.captured_at >= ${from} ${histZone}
        ORDER BY h.zone_id, date_trunc(${unitLit}, h.captured_at AT TIME ZONE 'UTC'), h.captured_at DESC
      )
      SELECT b::text AS "bucket", SUM(cnt)::int AS "inactive"
      FROM snap GROUP BY b`);

    // Live inactive count (same eligible-inactive definition as the snapshot) for the current bucket.
    const liveRows = await this.prisma.$queryRaw<{ inactive: number }[]>(Prisma.sql`
      SELECT COUNT(*) FILTER (WHERE ds.is_inactive = true AND ds.eligible_for_uptime = true)::int AS "inactive"
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      WHERE true ${dsZone} ${EXCLUDE_DEACTIVATED_PLANTS}`);
    const liveInactive = liveRows[0]?.inactive ?? 0;

    const troubleshootByBucket = new Map<string, number>();
    const installByBucket = new Map<string, number>();
    for (const r of ticketRows) {
      (r.workType === 'INSTALL' ? installByBucket : troubleshootByBucket).set(r.bucket, r.count);
    }
    const inactiveByBucket = new Map(histRows.map((r) => [r.bucket, r.inactive]));
    // The current bucket's live value wins over any earlier snapshot in the same bucket.
    inactiveByBucket.set(pgTimestamp(truncateUtc(now, unit)), liveInactive);

    const points: ActivityTrendPoint[] = enumerateBuckets(from, now, unit).map((d) => {
      const key = pgTimestamp(d);
      return {
        bucket: key,
        inactive: inactiveByBucket.has(key) ? inactiveByBucket.get(key)! : null,
        troubleshoot: troubleshootByBucket.get(key) ?? 0,
        installation: installByBucket.get(key) ?? 0,
      };
    });

    return {
      range: opts.range,
      from: from.toISOString(),
      to: now.toISOString(),
      bucket: unit,
      zoneId: restrictZone,
      points,
    };
  }

  /** Earliest ticket/snapshot timestamp in scope — the MAX-range lower bound; null when there is none. */
  private async earliestActivity(ticketZone: Prisma.Sql, histZone: Prisma.Sql): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<{ earliest: Date | null }[]>(Prisma.sql`
      SELECT LEAST(
        (SELECT MIN(t.created_at) FROM tickets t
           JOIN plants p ON p.plant_id = t.plant_id
           JOIN zones z ON z.zone_id = p.zone_id
           WHERE t.work_type IN ('TROUBLESHOOT', 'INSTALL') ${ticketZone} ${EXCLUDE_DEACTIVATED_PLANTS}),
        (SELECT MIN(h.captured_at) FROM soft_inactive_count_history h WHERE true ${histZone})
      ) AS "earliest"`);
    return rows[0]?.earliest ?? null;
  }
}

// ---- Activity-trend bucketing helpers (Issue 134) ---------------------------------------------

/** The bucket granularity for a range — coarser for longer windows so the point count stays sane. */
function bucketForRange(range: ActivityTrendRange): ActivityTrendBucket {
  switch (range) {
    case '1D':
      return 'hour';
    case '7D':
    case '1M':
      return 'day';
    case '1Y':
    case 'MAX':
      return 'month';
  }
}

/** The lower bound for a fixed range, relative to `now`. */
function windowStart(range: Exclude<ActivityTrendRange, 'MAX'> | '1Y', now: Date): Date {
  const day = 86_400_000;
  const back: Record<string, number> = { '1D': day, '7D': 7 * day, '1M': 30 * day, '1Y': 365 * day };
  return new Date(now.getTime() - (back[range] ?? 7 * day));
}

/** Truncate a Date to a UTC bucket start (hour / day / month). */
function truncateUtc(d: Date, unit: ActivityTrendBucket): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (unit === 'month') return new Date(Date.UTC(y, m, 1));
  if (unit === 'day') return new Date(Date.UTC(y, m, d.getUTCDate()));
  return new Date(Date.UTC(y, m, d.getUTCDate(), d.getUTCHours()));
}

/** `YYYY-MM-DD HH:MM:SS` in UTC — matches Postgres `date_trunc(...)::text` so the maps key-match. */
function pgTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Every bucket start from `from` to `to` (inclusive) at the given granularity; capped defensively. */
function enumerateBuckets(from: Date, to: Date, unit: ActivityTrendBucket): Date[] {
  const out: Date[] = [];
  let cur = truncateUtc(from, unit);
  const end = truncateUtc(to, unit);
  for (let guard = 0; cur.getTime() <= end.getTime() && guard < 5000; guard++) {
    out.push(cur);
    cur =
      unit === 'month'
        ? new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1))
        : new Date(cur.getTime() + (unit === 'hour' ? 3_600_000 : 86_400_000));
  }
  return out;
}
