import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type {
  AssignmentState,
  CompanyTier,
  SlaBucket,
  TicketStatus,
  WorkType,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A ticket as the manager surfaces see it. Bigint ids are serialised to strings (Nest cannot
 * JSON-serialise bigint). `slaBucket` and `failureCycleState` are read from the joined
 * `device_states` / `failure_cycles` rows so the row carries everything the inline badges need.
 */
export interface TicketView {
  ticketId: string;
  workType: WorkType;
  status: TicketStatus;
  failureCycleId: string | null;
  deviceId: string;
  vehicleId: string | null;
  plantId: string;
  companyId: string;
  companyTier: CompanyTier;
  assignmentState: AssignmentState;
  slaBucket: SlaBucket | null;
  repeatFailure: boolean;
  failureCycleState: string | null;
  createdAt: string;
  lastStateChangedAt: string;
}

export interface TicketLifecycleEvent {
  fromState: string | null;
  toState: string;
  actorId: string | null;
  actorRole: string | null;
  actedAsRole: string | null;
  reasonCode: string | null;
  at: string;
}

export interface TicketDetailView extends TicketView {
  lifecycle: TicketLifecycleEvent[];
}

export interface TicketScope {
  role: string;
  zoneId: number | null;
}

export interface TicketListFilters {
  status?: string;
  workType?: string;
  companyId?: string;
  plantId?: string;
  assignmentState?: string;
  bucket?: string;
  limit?: number;
  offset?: number;
}

const TICKET_STATUSES = [
  'OPEN', 'SUBMITTED', 'VERIFICATION_PENDING', 'CLOSED', 'CLOSED_AUTO_RECOVERY',
  'FAILED_VERIFICATION', 'ESCALATED', 'CLOSED_NON_OPERATIONAL', 'REQUESTED', 'SCHEDULED',
  'ON_SITE', 'FITTED', 'ACTIVATED', 'FAILED_ACTIVATION', 'COLLECTED', 'RECEIVED_AT_WAREHOUSE',
  'FAILED_RECOVERY',
];
const WORK_TYPES = ['TROUBLESHOOT', 'INSTALL', 'RECOVERY'];
const ASSIGNMENT_STATES = ['UNASSIGNED', 'FORMALLY_ASSIGNED'];
const SLA_BUCKETS = [
  'WARNING', 'EARLY_RISK', 'RISK', 'CRITICAL', 'HIGH_CRITICAL', 'SEVERE', 'VERY_SEVERE', 'LONG_PENDING',
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// SLA severity for the default descending sort (LONG_PENDING most severe; null/ACTIVE last).
const SEVERITY_RANK = Prisma.sql`CASE ds.sla_bucket
  WHEN 'LONG_PENDING' THEN 8 WHEN 'VERY_SEVERE' THEN 7 WHEN 'SEVERE' THEN 6
  WHEN 'HIGH_CRITICAL' THEN 5 WHEN 'CRITICAL' THEN 4 WHEN 'RISK' THEN 3
  WHEN 'EARLY_RISK' THEN 2 WHEN 'WARNING' THEN 1 ELSE 0 END`;

const SELECT_COLUMNS = Prisma.sql`
  t.ticket_id::text AS "ticketId", t.work_type::text AS "workType", t.status::text AS "status",
  t.failure_cycle_id::text AS "failureCycleId", t.device_id::text AS "deviceId",
  t.vehicle_id::text AS "vehicleId", t.plant_id::text AS "plantId", t.company_id::text AS "companyId",
  t.company_tier::text AS "companyTier", t.assignment_state::text AS "assignmentState",
  ds.sla_bucket::text AS "slaBucket", t.repeat_failure AS "repeatFailure",
  fc.state::text AS "failureCycleState", t.created_at AS "createdAt",
  t.last_state_changed_at AS "lastStateChangedAt"`;

const FROM_JOINS = Prisma.sql`
  FROM tickets t
  LEFT JOIN device_states ds ON ds.device_id = t.device_id
  LEFT JOIN failure_cycles fc ON fc.cycle_id = t.failure_cycle_id
  JOIN plants p ON p.plant_id = t.plant_id`;

type RawRow = {
  ticketId: string;
  workType: WorkType;
  status: TicketStatus;
  failureCycleId: string | null;
  deviceId: string;
  vehicleId: string | null;
  plantId: string;
  companyId: string;
  companyTier: CompanyTier;
  assignmentState: AssignmentState;
  slaBucket: SlaBucket | null;
  repeatFailure: boolean;
  failureCycleState: string | null;
  createdAt: Date;
  lastStateChangedAt: Date;
};

const toView = (r: RawRow): TicketView => ({
  ticketId: r.ticketId,
  workType: r.workType,
  status: r.status,
  failureCycleId: r.failureCycleId,
  deviceId: r.deviceId,
  vehicleId: r.vehicleId,
  plantId: r.plantId,
  companyId: r.companyId,
  companyTier: r.companyTier,
  assignmentState: r.assignmentState,
  slaBucket: r.slaBucket,
  repeatFailure: r.repeatFailure,
  failureCycleState: r.failureCycleState,
  createdAt: r.createdAt.toISOString(),
  lastStateChangedAt: r.lastStateChangedAt.toISOString(),
});

/** Read side of ticketing — the `/api/tickets/*` list and detail (Issue 05 AC#6 + Issue 07). */
@Injectable()
export class TicketQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(scope: TicketScope, filters: TicketListFilters = {}): Promise<TicketView[]> {
    const conds: Prisma.Sql[] = [];
    if (scope.role === 'ZONAL_MANAGER' && scope.zoneId !== null)
      conds.push(Prisma.sql`AND p.zone_id = ${BigInt(scope.zoneId)}`);
    if (filters.status && TICKET_STATUSES.includes(filters.status))
      conds.push(Prisma.sql`AND t.status = ${filters.status}::ticket_status`);
    if (filters.workType && WORK_TYPES.includes(filters.workType))
      conds.push(Prisma.sql`AND t.work_type = ${filters.workType}::work_type`);
    if (filters.assignmentState && ASSIGNMENT_STATES.includes(filters.assignmentState))
      conds.push(Prisma.sql`AND t.assignment_state = ${filters.assignmentState}::assignment_state`);
    if (filters.bucket && SLA_BUCKETS.includes(filters.bucket))
      conds.push(Prisma.sql`AND ds.sla_bucket = ${filters.bucket}::sla_bucket`);
    if (filters.companyId && /^\d+$/.test(filters.companyId))
      conds.push(Prisma.sql`AND t.company_id = ${BigInt(filters.companyId)}`);
    if (filters.plantId && /^\d+$/.test(filters.plantId))
      conds.push(Prisma.sql`AND t.plant_id = ${BigInt(filters.plantId)}`);
    const where = conds.length ? Prisma.join(conds, ' ') : Prisma.empty;

    const limit = Math.min(filters.limit && filters.limit > 0 ? filters.limit : 100, 500);
    const offset = filters.offset && filters.offset > 0 ? filters.offset : 0;

    const rows = await this.prisma.$queryRaw<RawRow[]>(Prisma.sql`
      SELECT ${SELECT_COLUMNS} ${FROM_JOINS}
      WHERE true ${where}
      ORDER BY ${SEVERITY_RANK} DESC, t.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`);
    return rows.map(toView);
  }

  async getById(ticketId: string, scope: TicketScope): Promise<TicketDetailView | null> {
    if (!UUID_RE.test(ticketId)) return null;
    const zoneCond =
      scope.role === 'ZONAL_MANAGER' && scope.zoneId !== null
        ? Prisma.sql`AND p.zone_id = ${BigInt(scope.zoneId)}`
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<RawRow[]>(Prisma.sql`
      SELECT ${SELECT_COLUMNS} ${FROM_JOINS}
      WHERE t.ticket_id = ${ticketId}::uuid ${zoneCond}
      LIMIT 1`);
    if (rows.length === 0) return null;

    const events = await this.prisma.ticketEvent.findMany({
      where: { ticketId },
      orderBy: { at: 'asc' },
    });
    const lifecycle: TicketLifecycleEvent[] = events.map((e) => ({
      fromState: e.fromState,
      toState: e.toState,
      actorId: e.actorId,
      actorRole: e.actorRole,
      actedAsRole: e.actedAsRole,
      reasonCode: e.reasonCode,
      at: e.at.toISOString(),
    }));
    return { ...toView(rows[0]), lifecycle };
  }
}
