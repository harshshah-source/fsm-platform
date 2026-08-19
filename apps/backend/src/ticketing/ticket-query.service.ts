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
import { readSpecialAttemptThreshold } from '../settings/special-threshold';
import { countableAttemptsSql, specialPredicateSql } from './special-ticket.query';

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
  /** Vehicle registration number (`vehicles.vehicle_no`) — the operator-facing identity. */
  vehicleNo: string | null;
  /** Transporter operating the vehicle (`vehicles.transporter → transporters.name`). Null when the
   * vehicle is unlinked or its transporter has not been mirrored from AutoPlant yet. */
  transporterName: string | null;
  plantId: string;
  /** Plant display name (may be an AutoPlant short code — the UI formats it). */
  plantName: string | null;
  companyId: string;
  companyName: string | null;
  companyTier: CompanyTier;
  zoneId: string | null;
  zoneName: string | null;
  assignmentState: AssignmentState;
  /** The SE holding the ticket's active day-plan batch (null while UNASSIGNED). */
  assignedSeId: string | null;
  assignedSeName: string | null;
  /** Active batch / schedule the ticket sits in (null while UNASSIGNED). */
  batchId: string | null;
  scheduleId: string | null;
  /** Dispatch run that produced the batch's schedule — links to the batch-assignment drill-down. Null
   * when the schedule predates the dispatch ledger (run_id is nullable). */
  runId: string | null;
  /** True when the assignment was ZM-overridden (batch or schedule status OVERRIDDEN). */
  overridden: boolean;
  slaBucket: SlaBucket | null;
  /** Device's last GPS ping (Issue 3) — the UI derives the elapsed inactive duration. Null if never seen. */
  latestGpsDatetime: string | null;
  /**
   * #238 — the device's measured silence in hours, as `device_states` derived it (never-reported
   * devices are aged from install, #223). Served because the SE-assignment threshold gates only
   * **auto**-dispatch: a ZM or CSM assigning intraday keeps their judgement, and the UI compares this
   * against the live threshold to badge the ticket as below it rather than refusing the click. The
   * derived figure is served rather than recomputed client-side from `latestGpsDatetime` so the badge
   * and the dispatch gate are reading the same number.
   */
  inactivityHours: number | null;
  repeatFailure: boolean;
  failureCycleState: string | null;
  /** Latest Component Request status for the ticket (Issue 23) — null when none was raised. */
  componentRequestStatus: string | null;
  /** SLA-pause timestamp while WAITING_COMPONENT (Issue 23); the UI derives "days elapsed". Null otherwise. */
  waitingComponentSince: string | null;
  /**
   * #244 — Special: repeatedly dispatched, actually reached in the mobile workflow, never
   * successfully worked. Derived per read (there is no column) from the same SQL expression the
   * `special` filter and the count evaluate, so a badged row and a filtered row cannot disagree.
   * Deliberately apart from `repeatFailure` / ESCALATED, which are failure-cycle facts about the
   * *device*; this is an observation about *attempts*.
   */
  isSpecial: boolean;
  /** Countable unsuccessful reached attempts behind {@link isSpecial} — the badge's "3/3". */
  specialAttempts: number;
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

/** One persisted SE troubleshoot-form submission for a ticket (Issue 16 → Issue 70 read). JSON-safe. */
export interface TicketFormView {
  submissionId: string;
  submissionType: string;
  seId: string;
  clientSubmissionId: string;
  rootCauseCategory: string;
  rootCauseSubcategory: string | null;
  rootCauseNotes: string | null;
  actionTakenCategory: string | null;
  actionTakenNotes: string | null;
  diagnosisNotes: string | null;
  componentUnavailable: boolean;
  componentUnavailableItem: string | null;
  photoRefs: string[];
  presenceSource: string;
  seGpsLat: number | null;
  seGpsLon: number | null;
  submittedAt: string;
}

export interface TicketScope {
  role: string;
  zoneId: number | null;
}

export interface TicketListFilters {
  status?: string;
  workType?: string;
  companyId?: string;
  /** Numeric plant id — exact match. */
  plantId?: string;
  /** Free-text plant lookup: matches the plant name (ILIKE) or, when numeric, the plant id. */
  plant?: string;
  /** Universal search: device id, vehicle number, plant name/id, company name/id. */
  q?: string;
  assignmentState?: string;
  bucket?: string;
  /** #244 — `'true'` narrows the list to Special tickets. Any other value is ignored, not treated as
   *  `false`: "special=0" meaning "only non-Special" is a filter nobody asked for and the queue has
   *  no control that would produce it. */
  special?: string;
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
  t.vehicle_id::text AS "vehicleId", v.vehicle_no AS "vehicleNo", tr.name AS "transporterName",
  t.plant_id::text AS "plantId", p.name AS "plantName",
  t.company_id::text AS "companyId", c.name AS "companyName",
  p.zone_id::text AS "zoneId", z.name AS "zoneName",
  t.company_tier::text AS "companyTier", t.assignment_state::text AS "assignmentState",
  asg.se_id::text AS "assignedSeId", asg.se_name AS "assignedSeName",
  asg.batch_id::text AS "batchId", asg.schedule_id::text AS "scheduleId", asg.run_id::text AS "runId",
  COALESCE(asg.batch_status = 'OVERRIDDEN' OR asg.schedule_status = 'OVERRIDDEN', false) AS "overridden",
  ds.sla_bucket::text AS "slaBucket", ds.latest_gps_datetime AS "latestGpsDatetime",
  ds.inactivity_hours AS "inactivityHours",
  t.repeat_failure AS "repeatFailure",
  fc.state::text AS "failureCycleState",
  CASE WHEN fc.state = 'WAITING_COMPONENT' THEN fc.sla_paused_at ELSE NULL END AS "waitingComponentSince",
  (SELECT cr.status::text FROM component_request cr WHERE cr.ticket_id = t.ticket_id
     ORDER BY cr.created_at DESC LIMIT 1) AS "componentRequestStatus",
  t.created_at AS "createdAt",
  t.last_state_changed_at AS "lastStateChangedAt"`;

// The ticket's ACTIVE day-plan assignment (Issue 122): its one live batch_assignment_tickets row
// (partial unique `WHERE removed_at IS NULL`) → batch → schedule → assigned-SE user. LATERAL keeps
// it one row per ticket; UNASSIGNED tickets simply carry NULLs.
const FROM_JOINS = Prisma.sql`
  FROM tickets t
  LEFT JOIN device_states ds ON ds.device_id = t.device_id
  LEFT JOIN failure_cycles fc ON fc.cycle_id = t.failure_cycle_id
  JOIN plants p ON p.plant_id = t.plant_id
  LEFT JOIN zones z ON z.zone_id = p.zone_id
  LEFT JOIN company_master c ON c.company_id = t.company_id
  LEFT JOIN vehicles v ON v.vehicle_id = t.vehicle_id
  LEFT JOIN transporters tr ON tr.transporter_id = v.transporter_id
  LEFT JOIN LATERAL (
    SELECT pba.batch_id, pba.status AS batch_status, pba.se_id, u.name AS se_name,
           ws.schedule_id, ws.status AS schedule_status, ws.run_id
    FROM batch_assignment_tickets bat
    JOIN plant_batch_assignments pba ON pba.batch_id = bat.batch_id
    JOIN work_schedules ws ON ws.schedule_id = pba.schedule_id
    LEFT JOIN users u ON u.user_id = pba.se_id
    WHERE bat.ticket_id = t.ticket_id AND bat.removed_at IS NULL
    ORDER BY bat.created_at DESC
    LIMIT 1
  ) asg ON true`;

type RawRow = {
  ticketId: string;
  workType: WorkType;
  status: TicketStatus;
  failureCycleId: string | null;
  deviceId: string;
  vehicleId: string | null;
  vehicleNo: string | null;
  transporterName: string | null;
  plantId: string;
  plantName: string | null;
  companyId: string;
  companyName: string | null;
  zoneId: string | null;
  zoneName: string | null;
  companyTier: CompanyTier;
  assignmentState: AssignmentState;
  assignedSeId: string | null;
  assignedSeName: string | null;
  batchId: string | null;
  scheduleId: string | null;
  runId: string | null;
  overridden: boolean;
  slaBucket: SlaBucket | null;
  latestGpsDatetime: Date | null;
  // `inactivity_hours` is a Postgres DOUBLE PRECISION; the driver hands it back as a JS number.
  inactivityHours: number | null;
  repeatFailure: boolean;
  failureCycleState: string | null;
  componentRequestStatus: string | null;
  waitingComponentSince: Date | null;
  isSpecial: boolean;
  specialAttempts: number | bigint;
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
  vehicleNo: r.vehicleNo,
  transporterName: r.transporterName,
  plantId: r.plantId,
  plantName: r.plantName,
  companyId: r.companyId,
  companyName: r.companyName,
  zoneId: r.zoneId,
  zoneName: r.zoneName,
  companyTier: r.companyTier,
  assignmentState: r.assignmentState,
  assignedSeId: r.assignedSeId,
  assignedSeName: r.assignedSeName,
  batchId: r.batchId,
  scheduleId: r.scheduleId,
  runId: r.runId,
  overridden: r.overridden,
  slaBucket: r.slaBucket,
  latestGpsDatetime: r.latestGpsDatetime ? r.latestGpsDatetime.toISOString() : null,
  inactivityHours: r.inactivityHours == null ? null : Number(r.inactivityHours),
  repeatFailure: r.repeatFailure,
  failureCycleState: r.failureCycleState,
  componentRequestStatus: r.componentRequestStatus,
  waitingComponentSince: r.waitingComponentSince ? r.waitingComponentSince.toISOString() : null,
  isSpecial: r.isSpecial,
  specialAttempts: Number(r.specialAttempts),
  createdAt: r.createdAt.toISOString(),
  lastStateChangedAt: r.lastStateChangedAt.toISOString(),
});

/** Read side of ticketing — the `/api/tickets/*` list and detail (Issue 05 AC#6 + Issue 07). */
@Injectable()
export class TicketQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * #244 — the two derived columns every ticket row carries, at the threshold in force **right now**.
   * Read per call, never cached: moving the key reclassifies the queue on the next refresh, which is
   * the whole point of Special being derived rather than stored.
   *
   * The countable-attempts expression is evaluated twice per row (once for the number, once inside
   * the predicate) rather than being computed once and re-used. That is deliberate: one definition in
   * one place is worth more here than one subquery fewer, the page is at most 500 rows, and #241's
   * `(ticket_id)` index is what the whole expression rides on.
   */
  private specialColumns(threshold: number): Prisma.Sql {
    return Prisma.sql`,
      ${countableAttemptsSql}::int AS "specialAttempts",
      ${specialPredicateSql(threshold)} AS "isSpecial"`;
  }

  async list(scope: TicketScope, filters: TicketListFilters = {}): Promise<TicketView[]> {
    const threshold = await readSpecialAttemptThreshold(this.prisma);
    const conds: Prisma.Sql[] = [];
    // #244 — the filter reuses the predicate the badge column renders, so the queue cannot show a
    // SPECIAL row that the Special filter then hides.
    if (filters.special === 'true') conds.push(Prisma.sql`AND ${specialPredicateSql(threshold)}`);
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
    // Free-text plant lookup — a numeric value matches the id OR the name (some plant names are codes).
    const plant = filters.plant?.trim();
    if (plant) {
      const like = `%${plant}%`;
      conds.push(
        /^\d+$/.test(plant)
          ? Prisma.sql`AND (t.plant_id = ${BigInt(plant)} OR p.name ILIKE ${like})`
          : Prisma.sql`AND p.name ILIKE ${like}`,
      );
    }
    // Universal search across the operator-facing identities (Issue 122 dashboard/ticket search).
    const q = filters.q?.trim();
    if (q) {
      const like = `%${q}%`;
      const idMatch = /^\d+$/.test(q)
        ? Prisma.sql` OR t.plant_id = ${BigInt(q)} OR t.company_id = ${BigInt(q)}`
        : Prisma.empty;
      // #161 D-4 downstream: a support call quotes the display label (`TCK-10306`), not the UUID —
      // match it against `ticket_no`. Kept separate from `idMatch` above (bare numeric `q` keeps its
      // existing plant/company-id meaning) so a plain "10306" is not accidentally reinterpreted; the
      // `TCK-` prefix is what disambiguates a ticket-number search. Dash optional for robustness.
      const ticketNoMatch = /^TCK-?(\d+)$/i.exec(q);
      const ticketNoMatchCond = ticketNoMatch
        ? Prisma.sql` OR t.ticket_no = ${BigInt(ticketNoMatch[1])}`
        : Prisma.empty;
      conds.push(Prisma.sql`AND (t.device_id ILIKE ${like} OR v.vehicle_no ILIKE ${like}
        OR p.name ILIKE ${like} OR c.name ILIKE ${like}${idMatch}${ticketNoMatchCond})`);
    }
    const where = conds.length ? Prisma.join(conds, ' ') : Prisma.empty;

    const limit = Math.min(filters.limit && filters.limit > 0 ? filters.limit : 100, 500);
    const offset = filters.offset && filters.offset > 0 ? filters.offset : 0;

    const rows = await this.prisma.$queryRaw<RawRow[]>(Prisma.sql`
      SELECT ${SELECT_COLUMNS} ${this.specialColumns(threshold)} ${FROM_JOINS}
      WHERE true ${where}
      ORDER BY ${SEVERITY_RANK} DESC, t.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`);
    return rows.map(toView);
  }

  /**
   * #244 — how many Special tickets the caller has, and the threshold that decided it.
   *
   * A separate read rather than a field on the list response, for two reasons: the list is a *page*
   * and a count over a page is not a count; and the queue shows the figure on a filter chip that must
   * be right before anybody clicks it. Zone-scoped exactly like the list — a ZM is told how many are
   * theirs, never a platform total they cannot open.
   */
  async countSpecial(scope: TicketScope): Promise<{ count: number; threshold: number }> {
    const threshold = await readSpecialAttemptThreshold(this.prisma);
    const zoneCond =
      scope.role === 'ZONAL_MANAGER' && scope.zoneId !== null
        ? Prisma.sql`AND p.zone_id = ${BigInt(scope.zoneId)}`
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT count(*) AS count
        FROM tickets t
        JOIN plants p ON p.plant_id = t.plant_id
       WHERE ${specialPredicateSql(threshold)} ${zoneCond}`);
    return { count: Number(rows[0]?.count ?? 0), threshold };
  }

  async getById(ticketId: string, scope: TicketScope): Promise<TicketDetailView | null> {
    if (!UUID_RE.test(ticketId)) return null;
    const zoneCond =
      scope.role === 'ZONAL_MANAGER' && scope.zoneId !== null
        ? Prisma.sql`AND p.zone_id = ${BigInt(scope.zoneId)}`
        : Prisma.empty;

    const threshold = await readSpecialAttemptThreshold(this.prisma);
    const rows = await this.prisma.$queryRaw<RawRow[]>(Prisma.sql`
      SELECT ${SELECT_COLUMNS} ${this.specialColumns(threshold)} ${FROM_JOINS}
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

  /**
   * The persisted SE troubleshoot-form submissions for a ticket (Issue 70, consumed by the FE-09 Forms
   * tab). Scope + existence are enforced by reusing {@link getById}: a ticket the caller can't see
   * (out-of-zone ZM, or unknown id) yields `null` → the controller 404s. Ordered oldest-first so a
   * WAITING_COMPONENT resubmit reads as a continuation of the original submission.
   */
  async formsForTicket(ticketId: string, scope: TicketScope): Promise<TicketFormView[] | null> {
    const ticket = await this.getById(ticketId, scope);
    if (!ticket) return null;

    const subs = await this.prisma.troubleshootingSubmission.findMany({
      where: { ticketId },
      orderBy: { submittedAt: 'asc' },
    });
    return subs.map((s) => ({
      submissionId: s.submissionId,
      submissionType: s.submissionType,
      seId: s.seId,
      clientSubmissionId: s.clientSubmissionId,
      rootCauseCategory: s.rootCauseCategory,
      rootCauseSubcategory: s.rootCauseSubcategory,
      rootCauseNotes: s.rootCauseNotes,
      actionTakenCategory: s.actionTakenCategory,
      actionTakenNotes: s.actionTakenNotes,
      diagnosisNotes: s.diagnosisNotes,
      componentUnavailable: s.componentUnavailable,
      componentUnavailableItem: s.componentUnavailableItem != null ? String(s.componentUnavailableItem) : null,
      photoRefs: s.photoRefs,
      presenceSource: s.presenceSource,
      seGpsLat: s.seGpsLat,
      seGpsLon: s.seGpsLon,
      submittedAt: s.submittedAt.toISOString(),
    }));
  }
}
