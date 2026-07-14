import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { type DealType, type SlaBucket } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export interface DeviceView {
  deviceId: string;
  dealType: DealType | null;
  currentVehicleId: string | null;
  deviceType: string | null;
  simId: string | null;
}

/** One row in the Device Detail list (FE-22), joining device state → vehicle / plant / zone / company. */
export interface DeviceListRow {
  deviceId: string;
  vehicleNo: string | null;
  deviceType: string | null;
  dealType: DealType | null;
  plantName: string | null;
  zoneName: string | null;
  companyName: string | null;
  slaBucket: SlaBucket | null;
  /** Device's last GPS ping (Issue 3) — the UI derives the elapsed inactive duration. Null if never seen. */
  latestGpsDatetime: string | null;
  isInactive: boolean;
  /** The device's latest live (not closed/failed) ticket, if any — the assignment context (Issue 122). */
  openTicketId: string | null;
  openTicketStatus: string | null;
  /** UNASSIGNED | FORMALLY_ASSIGNED for the open ticket; null when the device has no live ticket. */
  assignmentState: string | null;
  /** SE holding the open ticket's active day-plan batch (null while unassigned). */
  assignedSeName: string | null;
  batchId: string | null;
  batchStatus: string | null;
  scheduleId: string | null;
}

export interface DeviceListScope {
  role: string;
  zoneId: number | null;
}

/** A page of the Device Detail list: the rows for the requested window + the full filtered total. */
export interface DeviceListPage {
  rows: DeviceListRow[];
  total: number;
}

/** Device-status filter — the whole population, only-down, or only-live devices. */
export type DeviceStatusFilter = 'ALL' | 'INACTIVE' | 'ACTIVE';

/** How the list is ordered. `LONGEST_INACTIVE` (longest-pending first) is the default. */
export type DeviceSort = 'LONGEST_INACTIVE' | 'NEWEST_ACTIVITY' | 'SLA_SEVERITY' | 'DEVICE_ID' | 'PRIORITY';

export interface DeviceListFilters {
  search?: string;
  limit?: number;
  offset?: number;
  sort?: DeviceSort;
  status?: DeviceStatusFilter;
  bucket?: SlaBucket;
  /** Numeric zone id, or the literal `'UNZONED'` for plants with no zone (the bulk of the fleet). */
  zoneId?: number | 'UNZONED';
  companyId?: number;
  /** Restrict to devices at or above CRITICAL severity (the scorecard drill-down, Issue 122). */
  criticalPlus?: boolean;
}

/** The distinct zones / companies present in the caller's device scope — sources the filter dropdowns. */
export interface DeviceFilterOptions {
  zones: { zoneId: number; name: string }[];
  companies: { companyId: number; name: string }[];
  hasUnzoned: boolean;
}

const SLA_BUCKET_VALUES: readonly SlaBucket[] = [
  'WARNING', 'EARLY_RISK', 'RISK', 'CRITICAL', 'HIGH_CRITICAL', 'SEVERE', 'VERY_SEVERE', 'LONG_PENDING',
];

// SLA severity for the SLA_SEVERITY sort (LONG_PENDING most severe; null/ACTIVE last) — mirrors the
// ticket list's ranking so the two surfaces order identically.
const SEVERITY_RANK = Prisma.sql`CASE ds.sla_bucket
  WHEN 'LONG_PENDING' THEN 8 WHEN 'VERY_SEVERE' THEN 7 WHEN 'SEVERE' THEN 6
  WHEN 'HIGH_CRITICAL' THEN 5 WHEN 'CRITICAL' THEN 4 WHEN 'RISK' THEN 3
  WHEN 'EARLY_RISK' THEN 2 WHEN 'WARNING' THEN 1 ELSE 0 END`;

// Commercial priority for the PRIORITY sort (Platinum → Gold → Silver; untiered last).
const TIER_RANK = Prisma.sql`CASE c.company_tier
  WHEN 'PLATINUM' THEN 3 WHEN 'GOLD' THEN 2 WHEN 'SILVER' THEN 1 ELSE 0 END`;

// Longest-pending tie-break shared by the severity/priority sorts — oldest ping surfaces first.
const PENDING_TIEBREAK = Prisma.sql`ds.is_inactive DESC, ds.latest_gps_datetime ASC NULLS LAST`;

/** Whitelisted ORDER BY per sort key — never interpolate a raw sort string into SQL. */
const ORDER_BY: Record<DeviceSort, Prisma.Sql> = {
  LONGEST_INACTIVE: PENDING_TIEBREAK,
  NEWEST_ACTIVITY: Prisma.sql`ds.latest_gps_datetime DESC NULLS LAST`,
  SLA_SEVERITY: Prisma.sql`${SEVERITY_RANK} DESC, ${PENDING_TIEBREAK}`,
  DEVICE_ID: Prisma.sql`ds.device_id ASC`,
  PRIORITY: Prisma.sql`${TIER_RANK} DESC, c.company_priority_rank ASC NULLS LAST, ${PENDING_TIEBREAK}`,
};

export type SetDealTypeOutcome = { result: 'OK'; device: DeviceView } | { result: 'NOT_FOUND' };

export interface DealTypeActor {
  userId: string;
  role: string;
  actedAsRole?: string | null;
}

function toView(d: {
  deviceId: string;
  dealType: DealType | null;
  currentVehicleId: bigint | null;
  deviceType: string | null;
  simId: string | null;
}): DeviceView {
  return {
    deviceId: String(d.deviceId),
    dealType: d.dealType,
    currentVehicleId: d.currentVehicleId != null ? String(d.currentVehicleId) : null,
    deviceType: d.deviceType,
    simId: d.simId,
  };
}

/**
 * Device master reads + the Operations-Head manual `deal_type` tag (Issue 49, CONTEXT "Deal Type",
 * ADR-0014). `deal_type` (RECURRING | ONE_TIME, nullable) is conceptually sourced from CRM/SAP; with
 * no v1 integration it is set by the audited Ops-Head tag here (NULL = untagged). The first consumer
 * is #35 (Non-Operational dual-confirmation → Recovery Ticket creation on RECURRING).
 */
@Injectable()
export class DeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async setDealType(deviceId: string, dealType: DealType, actor: DealTypeActor): Promise<SetDealTypeOutcome> {
    const existing = await this.prisma.device.findUnique({ where: { deviceId } });
    if (!existing) return { result: 'NOT_FOUND' };

    const updated = await this.audit.withAudit(
      {
        actorId: actor.userId,
        actorRole: actor.role,
        actedAsRole: actor.actedAsRole ?? null,
        action: 'DEVICE_DEAL_TYPE_TAG',
        entityType: 'device',
        entityId: String(deviceId),
        metadata: { dealType, previous: existing.dealType },
      },
      (tx) => tx.device.update({ where: { deviceId }, data: { dealType } }),
    );
    return { result: 'OK', device: toView(updated) };
  }

  async getDevice(deviceId: string): Promise<DeviceView | null> {
    const d = await this.prisma.device.findUnique({ where: { deviceId } });
    return d ? toView(d) : null;
  }

  /**
   * The Device Detail list (FE-22, ref 22). Tracked devices (those with a `device_states` row) joined to
   * their vehicle / plant / zone / company, carrying the current SLA bucket. Zone-scoped like the ticket
   * reads (a ZM sees only their own zone; CSM / Operations Head see all), with an optional free-text
   * search over device id / vehicle no / plant / company. Inactive devices sort first (most urgent).
   *
   * Paginated (`limit`/`offset`): returns the requested window plus the full filtered `total` (a
   * `COUNT(*) OVER()` over the pre-limit set), so the UI can page through the whole fleet — the list is
   * far larger than one page (the top rows are always the longest-pending devices, never the whole set).
   *
   * Filterable by `status` (active/inactive), `bucket` (a single SLA bucket), `zoneId` (a zone or the
   * `'UNZONED'` holding set) and `companyId`; ordered by `sort` (default longest-inactive first). All
   * filter values are whitelisted/typed before they reach SQL — no raw interpolation.
   */
  async listDevices(scope: DeviceListScope, opts: DeviceListFilters = {}): Promise<DeviceListPage> {
    const conds = this.buildConds(scope, opts);
    const where = conds.length ? Prisma.join(conds, ' ') : Prisma.empty;
    const orderBy = ORDER_BY[opts.sort ?? 'LONGEST_INACTIVE'] ?? ORDER_BY.LONGEST_INACTIVE;
    const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 200) : 100;
    const offset = opts.offset && opts.offset > 0 ? opts.offset : 0;

    const rows = await this.prisma.$queryRaw<
      {
        deviceId: string;
        vehicleNo: string | null;
        deviceType: string | null;
        dealType: DealType | null;
        plantName: string | null;
        zoneName: string | null;
        companyName: string | null;
        slaBucket: SlaBucket | null;
        latestGpsDatetime: Date | null;
        isInactive: boolean;
        openTicketId: string | null;
        openTicketStatus: string | null;
        assignmentState: string | null;
        assignedSeName: string | null;
        batchId: string | null;
        batchStatus: string | null;
        scheduleId: string | null;
        total: number;
      }[]
    >(Prisma.sql`
      SELECT ds.device_id AS "deviceId", v.vehicle_no AS "vehicleNo", d.device_type AS "deviceType",
             d.deal_type AS "dealType", p.name AS "plantName", z.name AS "zoneName", c.name AS "companyName",
             ds.sla_bucket AS "slaBucket", ds.latest_gps_datetime AS "latestGpsDatetime", ds.is_inactive AS "isInactive",
             ot.ticket_id::text AS "openTicketId", ot.status::text AS "openTicketStatus",
             ot.assignment_state::text AS "assignmentState",
             asg.se_name AS "assignedSeName", asg.batch_id::text AS "batchId",
             asg.batch_status::text AS "batchStatus", asg.schedule_id::text AS "scheduleId",
             COUNT(*) OVER()::int AS "total"
      FROM device_states ds
      JOIN devices d ON d.device_id = ds.device_id
      LEFT JOIN vehicles v ON v.vehicle_id = ds.vehicle_id
      LEFT JOIN plants p ON p.plant_id = ds.plant_id
      LEFT JOIN zones z ON z.zone_id = p.zone_id
      LEFT JOIN company_master c ON c.company_id = ds.company_id
      LEFT JOIN LATERAL (
        SELECT t.ticket_id, t.status, t.assignment_state
        FROM tickets t
        WHERE t.device_id = ds.device_id
          AND t.status NOT IN ('CLOSED', 'CLOSED_AUTO_RECOVERY', 'CLOSED_NON_OPERATIONAL',
                               'FAILED_VERIFICATION', 'FAILED_ACTIVATION', 'FAILED_RECOVERY',
                               'RECEIVED_AT_WAREHOUSE')
        ORDER BY t.created_at DESC
        LIMIT 1
      ) ot ON true
      LEFT JOIN LATERAL (
        SELECT pba.batch_id, pba.status AS batch_status, ws.schedule_id, u.name AS se_name
        FROM batch_assignment_tickets bat
        JOIN plant_batch_assignments pba ON pba.batch_id = bat.batch_id
        JOIN work_schedules ws ON ws.schedule_id = pba.schedule_id
        LEFT JOIN users u ON u.user_id = pba.se_id
        WHERE bat.ticket_id = ot.ticket_id AND bat.removed_at IS NULL
        ORDER BY bat.created_at DESC
        LIMIT 1
      ) asg ON true
      WHERE 1=1 ${where}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}`);

    // COUNT(*) OVER() is the full filtered size, identical on every row; an empty window means 0 matches.
    const total = rows.length > 0 ? rows[0].total : 0;
    return {
      total,
      rows: rows.map(({ total: _total, ...r }) => ({
        ...r,
        deviceId: String(r.deviceId),
        latestGpsDatetime: r.latestGpsDatetime ? r.latestGpsDatetime.toISOString() : null,
      })),
    };
  }

  /** The scope + filter WHERE fragments shared by the list query (search only applies to the list). */
  private buildConds(scope: DeviceListScope, opts: DeviceListFilters): Prisma.Sql[] {
    const conds: Prisma.Sql[] = [];
    if (scope.role === 'ZONAL_MANAGER' && scope.zoneId !== null) {
      conds.push(Prisma.sql`AND p.zone_id = ${BigInt(scope.zoneId)}`);
    }
    const search = opts.search?.trim();
    if (search) {
      const q = `%${search}%`;
      conds.push(
        Prisma.sql`AND (CAST(ds.device_id AS TEXT) ILIKE ${q} OR v.vehicle_no ILIKE ${q} OR p.name ILIKE ${q} OR c.name ILIKE ${q})`,
      );
    }
    if (opts.status === 'INACTIVE') conds.push(Prisma.sql`AND ds.is_inactive = true`);
    else if (opts.status === 'ACTIVE') conds.push(Prisma.sql`AND ds.is_inactive = false`);

    if (opts.bucket && SLA_BUCKET_VALUES.includes(opts.bucket)) {
      conds.push(Prisma.sql`AND ds.sla_bucket = ${opts.bucket}::sla_bucket`);
    }
    if (opts.criticalPlus) {
      conds.push(
        Prisma.sql`AND ds.sla_bucket IN ('CRITICAL','HIGH_CRITICAL','SEVERE','VERY_SEVERE','LONG_PENDING')`,
      );
    }
    if (opts.zoneId === 'UNZONED') conds.push(Prisma.sql`AND p.zone_id IS NULL`);
    else if (typeof opts.zoneId === 'number' && Number.isFinite(opts.zoneId)) {
      conds.push(Prisma.sql`AND p.zone_id = ${BigInt(opts.zoneId)}`);
    }
    if (typeof opts.companyId === 'number' && Number.isFinite(opts.companyId)) {
      conds.push(Prisma.sql`AND ds.company_id = ${BigInt(opts.companyId)}`);
    }
    return conds;
  }

  /**
   * The distinct zones and companies present in the caller's device scope (zone-scoped for a ZM), plus
   * whether any device is UNZONED — the source for the Device Detail filter dropdowns. Deriving these
   * from the device population (not the full org tables) keeps the options relevant AND reuses the
   * list's own role scope, so it needs no separate Ops-Head-only config read.
   */
  async filterOptions(scope: DeviceListScope): Promise<DeviceFilterOptions> {
    const zmScope =
      scope.role === 'ZONAL_MANAGER' && scope.zoneId !== null
        ? Prisma.sql`AND p.zone_id = ${BigInt(scope.zoneId)}`
        : Prisma.empty;

    const [zones, companies, unzoned] = await Promise.all([
      this.prisma.$queryRaw<{ zoneId: bigint; name: string }[]>(Prisma.sql`
        SELECT DISTINCT z.zone_id AS "zoneId", z.name AS "name"
        FROM device_states ds
        JOIN plants p ON p.plant_id = ds.plant_id
        JOIN zones z ON z.zone_id = p.zone_id
        WHERE 1=1 ${zmScope}
        ORDER BY z.name ASC`),
      this.prisma.$queryRaw<{ companyId: bigint; name: string }[]>(Prisma.sql`
        SELECT DISTINCT c.company_id AS "companyId", c.name AS "name"
        FROM device_states ds
        JOIN company_master c ON c.company_id = ds.company_id
        LEFT JOIN plants p ON p.plant_id = ds.plant_id
        WHERE 1=1 ${zmScope}
        ORDER BY c.name ASC`),
      this.prisma.$queryRaw<{ has: boolean }[]>(Prisma.sql`
        SELECT EXISTS (
          SELECT 1 FROM device_states ds
          LEFT JOIN plants p ON p.plant_id = ds.plant_id
          WHERE p.zone_id IS NULL ${zmScope}
        ) AS "has"`),
    ]);

    return {
      zones: zones.map((z) => ({ zoneId: Number(z.zoneId), name: z.name })),
      companies: companies.map((c) => ({ companyId: Number(c.companyId), name: c.name })),
      hasUnzoned: unzoned[0]?.has ?? false,
    };
  }
}
