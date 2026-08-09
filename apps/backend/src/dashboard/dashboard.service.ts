import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Devices on a deactivated plant (Issue 119) drop out of every dashboard count + SLA bucket; they are
 *  surfaced instead on the OH "Plant Deactivations" list. Self-contained predicate — appended to any
 *  aggregation joined to `plants p`. */
export const EXCLUDE_DEACTIVATED_PLANTS = Prisma.sql`AND p.plant_id NOT IN (SELECT plant_id FROM plant_deactivations WHERE reactivated_at IS NULL)`;

/**
 * The ONE aggregate projection every fleet count on the dashboard is derived from — zone rows,
 * company×plant rows, the Fleet Directory, and the headline KPI strip all select exactly this
 * fragment over `device_states ds`, differing only in their `GROUP BY`.
 *
 * That sameness is the point. The 2026-07-29 defect was a numerator and a denominator computed by
 * two *separate* statements that disagreed about whether a departed (warehoused) device counts:
 * `is_inactive` is false for every departed device by construction (`DeviceStateService.recompute`
 * forces `is_inactive = NOT departed AND …`), but the denominator query had no `is_departed`
 * predicate, so `inactive / total` divided an operational numerator by an operational+warehouse
 * denominator. Deriving every level from one expression makes that class of drift unrepresentable:
 * a population change edits one fragment and moves every layer together.
 *
 * The counts partition the scope exactly:
 *   mirrored    = operational + warehouse
 *   operational = healthy + inactive + neverReported          (#223 — see the three predicates below)
 *   reporting   = healthy + inactive
 *
 * `inactive` keeps the historical predicate `is_inactive AND sla_bucket IS NOT NULL`, narrowed by
 * #223's "has reported" clause — so `byBucket` still sums to exactly `inactiveOperational`, since both
 * read the same bucketed rows.
 *
 * **Exported for the Operations Data Explorer's reconciliation panel (#217).** That panel asserts the
 * identities in the paragraph above over the whole live database. It must import this fragment rather
 * than restate the predicates: a checker written from a second spelling only verifies that the second
 * spelling agrees with itself, which is precisely the failure mode #176 closed. Nothing outside
 * `dashboard/` and `ops-explorer/` should need it.
 */

/**
 * Operational AND has sent at least one GPS fix — the population every fleet rate is taken over (#223).
 *
 * `latest_gps_datetime IS NULL` used to be invisible to every predicate on this page, and that is the
 * whole of defect #223: `healthy` was defined as the *negation* of `inactive`, `is_inactive` requires a
 * timestamp to compare against (`device-state.service.ts` guards it with `hours IS NOT NULL`), so a
 * device that had never reported could not be inactive and was therefore swept into healthy. 913
 * devices fleet-wide — 892 of them confirmed at the source as fitted, deployed, and never having sent
 * a single fix — were counted as the healthiest thing in the fleet. Absence of evidence read as
 * evidence of health.
 */
export const REPORTING_OPERATIONAL = Prisma.sql`ds.is_departed = false AND ds.latest_gps_datetime IS NOT NULL`;

/**
 * Operational, has reported, and is currently silent past the inactivity threshold.
 *
 * The "has reported" clause is load-bearing and is NOT redundant with `sla_bucket IS NOT NULL`. Under
 * #223 an NDD device that has been fitted longer than the grace window IS `is_inactive` and DOES carry
 * an SLA bucket — that is P1 (a fitted tracker that has never reported is a fault, ticketed like any
 * other silent device). Without this clause such a device would be counted in both `inactiveOperational`
 * and `neverReported`, and the identity would overshoot `operationalDevices`.
 */
export const INACTIVE_OPERATIONAL = Prisma.sql`${REPORTING_OPERATIONAL} AND ds.is_inactive = true AND ds.sla_bucket IS NOT NULL`;

/** Operational, has reported, and is not currently silent. "Reporting normally" — at last literally. */
export const HEALTHY_OPERATIONAL = Prisma.sql`${REPORTING_OPERATIONAL} AND NOT (ds.is_inactive = true AND ds.sla_bucket IS NOT NULL)`;

/**
 * The third state (#223): operational and no GPS fix has ever arrived.
 *
 * Deliberately derived from `latest_gps_datetime` at read time rather than stored as a
 * `device_states.never_reported` column, which is what the issue's design proposed. A stored boolean
 * would be a pure function of another column on the same row — but the two are maintained by
 * DIFFERENT writers: `latest_gps_datetime` is advanced at INGEST (`SnapshotIngestionService`, every
 * 30 min) while a derived flag would be written by `DeviceStateService.recompute`. Between an ingest
 * that brings a device to life and the next recompute, the stored flag would still say "never
 * reported" for a device that just did. Derived, it cannot be wrong; stored, it is wrong for up to one
 * recompute interval — on exactly the transition that matters most.
 *
 * Note this counts a never-reported device regardless of the grace window. The window governs whether
 * such a device is *inactive* (and therefore ticketed), not whether it has reported: "has never sent a
 * fix" is a fact about the device, not a judgement about it, and the partition has to be exhaustive.
 */
export const NEVER_REPORTED_OPERATIONAL = Prisma.sql`ds.is_departed = false AND ds.latest_gps_datetime IS NULL`;

export const FLEET_COUNT_COLUMNS = Prisma.sql`
  COUNT(*)::int AS "mirroredDevices",
  COUNT(*) FILTER (WHERE ds.is_departed = false)::int AS "operationalDevices",
  COUNT(*) FILTER (WHERE ds.is_departed = true)::int AS "warehouseDevices",
  COUNT(*) FILTER (WHERE ${REPORTING_OPERATIONAL})::int AS "reportingOperational",
  COUNT(*) FILTER (WHERE ${INACTIVE_OPERATIONAL})::int AS "inactiveOperational",
  COUNT(*) FILTER (WHERE ${HEALTHY_OPERATIONAL})::int AS "healthyOperational",
  COUNT(*) FILTER (WHERE ${NEVER_REPORTED_OPERATIONAL})::int AS "neverReported"`;

/**
 * The device counts for one entity (a zone, a company, a plant, or the whole scope), over the single
 * operational population defined by {@link FLEET_COUNT_COLUMNS}. Every consumer of `inactive / total`
 * reads `inactiveOperational / operationalDevices` — never a mirrored total.
 */
export interface FleetCounts {
  /** Every device FSM mirrors for this entity: operational + warehouse. NOT the AutoPlant catalog. */
  mirroredDevices: number;
  /** Deployed and tracked — the denominator for every rate on the dashboard. `is_departed = false`. */
  operationalDevices: number;
  /** Removed from field operations (an open `device_departures` row) — in a warehouse, not broken. */
  warehouseDevices: number;
  /**
   * Operational devices that have sent at least one GPS fix — `operationalDevices − neverReported`,
   * and the denominator of both rates below (#223 P3). Named rather than left implicit because "the
   * denominator" is precisely what the two-state model got wrong.
   */
  reportingOperational: number;
  /** Reporting devices currently inactive (silent ≥ the inactivity threshold, so SLA-bucketed). */
  inactiveOperational: number;
  /** Reporting devices that are NOT inactive. `healthy + inactive = reportingOperational`. */
  healthyOperational: number;
  /**
   * Operational devices that have never sent a single GPS fix (#223) — the third state, reported
   * beside Fleet Health rather than inside it (operator decision P4, 2026-08-09).
   *
   * `healthyOperational + inactiveOperational + neverReported = operationalDevices`.
   */
  neverReported: number;
  /** `inactiveOperational / reportingOperational × 100`, 1dp; null when nothing has reported. */
  inactivePct: number | null;
  /** `healthyOperational / reportingOperational × 100`, 1dp; null when nothing has reported. */
  fleetHealthPct: number | null;
}

/** The raw five counts as selected by {@link FLEET_COUNT_COLUMNS}, before the rates are derived. */
type RawFleetCounts = Omit<FleetCounts, 'inactivePct' | 'fleetHealthPct'>;

/**
 * Derive the two rates from the counts. Both are percentages of the **reporting** fleet — a warehouse
 * device is neither healthy nor inactive, and (since #223) neither is a device that has never reported.
 * Null (rendered "—") rather than 0 when there is nothing to divide by, so an entity with no reporting
 * devices never reads as "0% healthy".
 *
 * **The denominator is `reportingOperational`, not `operationalDevices` — operator decision P3
 * (2026-08-09).** The alternative on the table was scoring never-reported devices as 0% uptime and
 * leaving them in the denominator. Both are defensible; the operator's reasoning for excluding them was
 * that it *"keeps the KPI measuring what it claims: reliability of devices that have reported"*, with
 * the never-reported count sitting beside the KPI instead of being blended into it. Pan-India this moves
 * Fleet Health from a fictional 82.96% to a measured 84.84% once #222 lands with it.
 */
function withRates(counts: RawFleetCounts): FleetCounts {
  const reporting = counts.reportingOperational;
  const pct = (n: number) => (reporting > 0 ? Math.round((n / reporting) * 1000) / 10 : null);
  return { ...counts, inactivePct: pct(counts.inactiveOperational), fleetHealthPct: pct(counts.healthyOperational) };
}

export interface ZoneOverviewRow extends FleetCounts {
  zoneId: string;
  zoneName: string;
  /** The zone's Zonal Manager display name (`zones.zonal_manager_user_id` → `users.name`); null if unset. */
  zonalManagerName: string | null;
  /** Count of inactive devices per SLA bucket. Sums to `inactiveOperational`; healthy devices never appear. */
  byBucket: Record<string, number>;
  /** Trend % vs previous day — null until the daily-history table lands (Issue 40). */
  trendPctVsPrevDay: number | null;
}

export interface CompanyPlantRow extends FleetCounts {
  companyId: string;
  companyName: string;
  companyTier: string;
  zoneId: string;
  plantId: string;
  plantName: string;
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

/**
 * Headline fleet counts for the dashboard KPI strip. Extends {@link FleetCounts}, so the KPI cards and
 * the zone / company tables below them are literally the same aggregate at different `GROUP BY`
 * levels — `Σ zone.operationalDevices == fleet.operationalDevices` holds by construction.
 */
export interface FleetSummary extends FleetCounts {
  companies: number;
  plants: number;
  /**
   * SOURCE metric, not an operational one: the raw AutoPlant device-catalog size from the last
   * successful master sync — every fitted `device_id` the source read observed, all deployment
   * statuses, pan-India. NOT scope-filtered (the source read is not zone-attributed) and NOT
   * comparable to the operational counts above: it is a different system's inventory, as of a
   * different moment. Null until a master sync has recorded it. Rendered as "AutoPlant Catalog".
   */
  catalogDevices: number | null;
  /** When the master sync that produced {@link catalogDevices} finished. Null when there is none. */
  lastMasterSyncAt: string | null;
  /** When the most recent successful telemetry snapshot finished — how fresh the inactivity ages are. */
  lastSnapshotAt: string | null;
}

/** One company in the Fleet Directory (Issue 122b KPI click-through). */
export interface FleetDirectoryCompany extends FleetCounts {
  companyId: string;
  name: string;
  tier: string | null;
  plantCount: number;
  /** Latest `device_states.computed_at` across this company's devices — when FSM last re-derived them. */
  lastSnapshotAt: string | null;
  /** Latest GPS ping across this company's devices — when its fleet last reported from the field. */
  lastActivityAt: string | null;
}

/** One plant in the Fleet Directory. */
export interface FleetDirectoryPlant extends FleetCounts {
  plantId: string;
  name: string;
  companyId: string | null;
  companyName: string | null;
  zoneName: string | null;
  lastSnapshotAt: string | null;
  lastActivityAt: string | null;
}

export interface FleetDirectory {
  companies: FleetDirectoryCompany[];
  plants: FleetDirectoryPlant[];
}

/**
 * The Fleet Composition funnel — AutoPlant's catalog narrowed, one accounted-for step at a time, to
 * the healthy/inactive split the dashboard reports on. Every step states what it drops, so the chain
 * has no unexplained losses:
 *
 *   catalogDevices                                  (AutoPlant, all deployment statuses)
 *     − notMirrored              → mirroredTotal    (never mirrored: non-operational + never known)
 *     − onDeactivatedPlants      → mirroredDevices  (plant deactivated, Issue 119)
 *     → operationalDevices + warehouseDevices
 *     operationalDevices → healthyOperational + inactiveOperational + neverReported   ← THREE, not two
 *
 * The last step gained its third branch in #223. Rendered as a two-way split it no longer sums: 913
 * devices fleet-wide have never sent a GPS fix, and they were previously absorbed into `healthy` by
 * the negation rather than being shown as their own loss.
 *
 * `catalogDevices` / `notMirrored` are pan-India by nature and are null for a zone-scoped caller (a
 * ZM), whose funnel starts at "Mirrored into FSM" instead.
 */
export interface FleetComposition extends FleetCounts {
  catalogDevices: number | null;
  notMirrored: number | null;
  /** Every `device_states` row in scope, INCLUDING devices on deactivated plants. */
  mirroredTotal: number;
  onDeactivatedPlants: number;
  /** True when the caller is clamped to one zone, so the catalog steps are omitted. */
  zoneScoped: boolean;
  lastMasterSyncAt: string | null;
  lastSnapshotAt: string | null;
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

/**
 * Ticket statuses that mean "this work is over". The complement is what the Device Detail list calls a
 * live ticket (`device.service.ts`' `ot` lateral) — restated here as a named constant rather than a
 * second hand-spelled list, because the drill-down's assignment counts must agree with that table's
 * per-row assignment column exactly.
 */
const CLOSED_TICKET_STATUSES = [
  'CLOSED',
  'CLOSED_AUTO_RECOVERY',
  'CLOSED_NON_OPERATIONAL',
  'FAILED_VERIFICATION',
  'FAILED_ACTIVATION',
  'FAILED_RECOVERY',
  'RECEIVED_AT_WAREHOUSE',
] as const;

/**
 * The Device Detail page's device-status filter, as it scopes the zone drill-down's aggregates.
 *
 * `NEVER_REPORTED` added by #223 (operator decision P4 — the third state is reported separately, not
 * folded into a widened "not reporting" figure). `ACTIVE` no longer includes never-reported devices.
 */
export type DeviceStatusScope = 'ALL' | 'INACTIVE' | 'ACTIVE' | 'NEVER_REPORTED';

/**
 * How a zone's currently-open work is held (see {@link DashboardService.zoneOperations}).
 * `assigned + unassigned` need not equal `openTickets` — a ticket in another assignment state (e.g.
 * mid-transition) is counted in the total and in neither split, and the UI shows the total.
 */
export interface ZoneOperationsSummary {
  /** Live (not closed/failed) tickets in scope. */
  openTickets: number;
  assigned: number;
  unassigned: number;
  /** Distinct live batches holding those tickets. */
  liveBatches: number;
  /** Of those batches, how many a manager has overridden. */
  overriddenBatches: number;
  /** Distinct SEs holding at least one of those batches. */
  engineersEngaged: number;
}

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

  /**
   * Zone Overview / Zone Performance Scorecard rows — one per zone that has ANY mirrored device on a
   * live plant, carrying the full operational breakdown ({@link FleetCounts}) plus the per-SLA-bucket
   * inactive split.
   *
   * Rows are driven by the COUNTS query, not by the bucket query. Previously a zone only existed if it
   * had at least one inactive device, so a zone at 100% health silently vanished from the scorecard —
   * and its operational devices vanished from the column totals with it, breaking
   * `Σ zone.operationalDevices == fleet.operationalDevices`. A healthy zone now renders `0 / N`.
   */
  async zoneOverview(scope: ZoneScope): Promise<ZoneOverviewRow[]> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const zoneFilter =
      restrictZone !== null ? Prisma.sql`AND z.zone_id = ${BigInt(restrictZone)}` : Prisma.empty;

    const counts = await this.prisma.$queryRaw<Array<RawFleetCounts & { zoneId: string; zoneName: string }>>(Prisma.sql`
      SELECT z.zone_id::text AS "zoneId", z.name AS "zoneName", ${FLEET_COUNT_COLUMNS}
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      WHERE true ${zoneFilter} ${EXCLUDE_DEACTIVATED_PLANTS}
      GROUP BY z.zone_id, z.name
      ORDER BY z.zone_id`);

    // The per-bucket split of the SAME inactive population the counts query measures (the IMPORTED
    // predicate, not a second spelling of it), so `Σ byBucket == inactiveOperational` for every row.
    // #223 matters here specifically: an NDD device aged from its install date buckets like any other,
    // and 602 of the 907 are >1 year old, so every one would land in the open-ended top band. That band
    // holds 1,456 devices today — adding 602 is +41%, and the genuine 7-day backlog becomes unreadable.
    const grouped = await this.prisma.$queryRaw<GroupedRow[]>(Prisma.sql`
      SELECT z.zone_id::text AS "zoneId", z.name AS "zoneName",
             ds.sla_bucket::text AS "slaBucket", COUNT(*)::int AS "count"
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      WHERE ${INACTIVE_OPERATIONAL}
        ${zoneFilter} ${EXCLUDE_DEACTIVATED_PLANTS}
      GROUP BY z.zone_id, z.name, ds.sla_bucket`);

    // Zonal Manager display name per zone (Issue 122 scorecard column) — tiny unconditional read.
    const zms = await this.prisma.$queryRaw<{ zoneId: string; zmName: string | null }[]>(Prisma.sql`
      SELECT z.zone_id::text AS "zoneId", u.name AS "zmName"
      FROM zones z LEFT JOIN users u ON u.user_id = z.zonal_manager_user_id`);
    const zmByZone = new Map(zms.map((z) => [z.zoneId, z.zmName]));

    const byZone = new Map<string, ZoneOverviewRow>();
    for (const { zoneId, zoneName, ...raw } of counts) {
      byZone.set(zoneId, {
        zoneId,
        zoneName,
        zonalManagerName: zmByZone.get(zoneId) ?? null,
        ...withRates(raw),
        byBucket: {},
        trendPctVsPrevDay: null,
      });
    }
    for (const r of grouped) {
      const row = byZone.get(r.zoneId);
      if (row) row.byBucket[r.slaBucket] = r.count;
    }
    return [...byZone.values()];
  }

  /**
   * Headline fleet counts (the KPI strip): distinct companies, distinct plants, and the full
   * operational breakdown in the caller's scope, plus the pan-India source-catalog total and the two
   * freshness stamps.
   *
   * The operational counts come from {@link FLEET_COUNT_COLUMNS} — the same fragment
   * {@link zoneOverview} and {@link companyPlantOverview} group by — so the KPI cards and the tables
   * beneath them cannot disagree. `catalogDevices` is the odd one out and is labelled as such: a
   * SOURCE metric from another system, pan-India, never scope-filtered (see {@link sourceDeviceTotal}).
   */
  async fleetSummary(scope: ZoneScope): Promise<FleetSummary> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const zoneFilter =
      restrictZone !== null ? Prisma.sql`AND p.zone_id = ${BigInt(restrictZone)}` : Prisma.empty;

    const rows = await this.prisma.$queryRaw<Array<RawFleetCounts & { companies: number; plants: number }>>(Prisma.sql`
      SELECT COUNT(DISTINCT ds.company_id)::int AS "companies",
             COUNT(DISTINCT ds.plant_id)::int AS "plants",
             ${FLEET_COUNT_COLUMNS}
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      WHERE true ${zoneFilter} ${EXCLUDE_DEACTIVATED_PLANTS}`);
    const { companies = 0, plants = 0, ...raw } = rows[0] ?? {};
    const [sync, snapshotAt] = await Promise.all([this.latestMasterSync(), this.latestSnapshotAt()]);
    return {
      companies,
      plants,
      ...withRates({
        mirroredDevices: raw.mirroredDevices ?? 0,
        operationalDevices: raw.operationalDevices ?? 0,
        warehouseDevices: raw.warehouseDevices ?? 0,
        reportingOperational: raw.reportingOperational ?? 0,
        inactiveOperational: raw.inactiveOperational ?? 0,
        healthyOperational: raw.healthyOperational ?? 0,
        neverReported: raw.neverReported ?? 0,
      }),
      catalogDevices: sync.observed,
      lastMasterSyncAt: sync.finishedAt,
      lastSnapshotAt: snapshotAt,
    };
  }

  /**
   * The Fleet Composition funnel (see {@link FleetComposition}) — every step from the AutoPlant
   * catalog down to the healthy/inactive split, with each drop named. `mirroredTotal` deliberately
   * drops the `EXCLUDE_DEACTIVATED_PLANTS` predicate so the deactivated-plant step is a visible,
   * quantified loss rather than an invisible one.
   */
  async fleetComposition(scope: ZoneScope): Promise<FleetComposition> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const zoneFilter =
      restrictZone !== null ? Prisma.sql`AND p.zone_id = ${BigInt(restrictZone)}` : Prisma.empty;

    const [live] = await this.prisma.$queryRaw<RawFleetCounts[]>(Prisma.sql`
      SELECT ${FLEET_COUNT_COLUMNS}
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      WHERE true ${zoneFilter} ${EXCLUDE_DEACTIVATED_PLANTS}`);
    // Same scope, WITHOUT the deactivated-plant exclusion — the difference is the funnel's step 3.
    const [all] = await this.prisma.$queryRaw<{ mirroredTotal: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS "mirroredTotal"
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      WHERE true ${zoneFilter}`);

    const counts = withRates({
      mirroredDevices: live?.mirroredDevices ?? 0,
      operationalDevices: live?.operationalDevices ?? 0,
      warehouseDevices: live?.warehouseDevices ?? 0,
      reportingOperational: live?.reportingOperational ?? 0,
      inactiveOperational: live?.inactiveOperational ?? 0,
      healthyOperational: live?.healthyOperational ?? 0,
      neverReported: live?.neverReported ?? 0,
    });
    const mirroredTotal = all?.mirroredTotal ?? 0;
    const [sync, snapshotAt] = await Promise.all([this.latestMasterSync(), this.latestSnapshotAt()]);
    // The catalog is a pan-India source counter with no zone attribution, so a zone-scoped funnel
    // cannot honestly open with it — it starts at "Mirrored into FSM" instead.
    const zoneScoped = restrictZone !== null;
    const catalogDevices = zoneScoped ? null : sync.observed;
    return {
      ...counts,
      catalogDevices,
      notMirrored: catalogDevices === null ? null : catalogDevices - mirroredTotal,
      mirroredTotal,
      onDeactivatedPlants: mirroredTotal - counts.mirroredDevices,
      zoneScoped,
      lastMasterSyncAt: sync.finishedAt,
      lastSnapshotAt: snapshotAt,
    };
  }

  /**
   * The raw AutoPlant device-catalog size recorded by the most recent SUCCESSFUL master sync
   * (`entity_stats -> 'devices' -> 'observed'`) — every fitted `device_id` the source read saw,
   * across all deployment statuses — together with when that sync finished. This is the "AutoPlant
   * Catalog" KPI; the mirrored fleet is a subset of it. Null until a sync has recorded the counter
   * (older runs, or a fresh DB), which the UI renders as "—".
   */
  private async latestMasterSync(): Promise<{ observed: number | null; finishedAt: string | null }> {
    const rows = await this.prisma.$queryRaw<{ observed: number | null; finishedAt: Date | null }[]>(Prisma.sql`
      SELECT (entity_stats -> 'devices' ->> 'observed')::int AS "observed",
             finished_at AS "finishedAt"
      FROM master_sync_runs
      WHERE status = 'SUCCESS' AND entity_stats -> 'devices' ->> 'observed' IS NOT NULL
      ORDER BY finished_at DESC NULLS LAST
      LIMIT 1`);
    return { observed: rows[0]?.observed ?? null, finishedAt: rows[0]?.finishedAt?.toISOString() ?? null };
  }

  /**
   * When the most recent SUCCESSFUL telemetry snapshot finished — the freshness of every inactivity
   * age, and therefore of every inactive count on the dashboard. Surfaced beside the operational KPIs
   * so a manager can tell "0 inactive" from "we haven't heard from the source since Tuesday".
   */
  private async latestSnapshotAt(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ finishedAt: Date | null }[]>(Prisma.sql`
      SELECT finished_at AS "finishedAt"
      FROM snapshot_runs
      WHERE status = 'SUCCESS' AND finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1`);
    return rows[0]?.finishedAt?.toISOString() ?? null;
  }

  /**
   * The Fleet Directory (the Companies/Plants KPI click-through): every company and plant in the
   * caller's scope BY NAME, with the full operational breakdown and two freshness stamps —
   * `lastSnapshotAt` (when FSM last re-derived the entity's device rows) and `lastActivityAt` (when
   * its fleet last pinged from the field).
   *
   * Same {@link FLEET_COUNT_COLUMNS} aggregate as the KPI strip and the zone table, so
   * `Σ company.operationalDevices == Σ plant.operationalDevices == fleet.operationalDevices`. The
   * pre-fix directory selected a bare `COUNT(*)` and so summed to the MIRRORED total (23,238) while
   * claiming in its own docstring to reconcile with the Active Fleet KPI (17,415) — it never did.
   */
  async fleetDirectory(scope: ZoneScope): Promise<FleetDirectory> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const zoneFilter =
      restrictZone !== null ? Prisma.sql`AND z.zone_id = ${BigInt(restrictZone)}` : Prisma.empty;
    const freshness = Prisma.sql`
      MAX(ds.computed_at) AS "lastSnapshotAt",
      MAX(ds.latest_gps_datetime) AS "lastActivityAt"`;

    const companies = await this.prisma.$queryRaw<
      Array<RawFleetCounts & { companyId: string; name: string; tier: string | null; plantCount: number; lastSnapshotAt: Date | null; lastActivityAt: Date | null }>
    >(Prisma.sql`
      SELECT c.company_id::text AS "companyId", c.name AS "name", c.company_tier::text AS "tier",
             COUNT(DISTINCT ds.plant_id)::int AS "plantCount", ${FLEET_COUNT_COLUMNS}, ${freshness}
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      JOIN company_master c ON c.company_id = ds.company_id
      WHERE true ${zoneFilter} ${EXCLUDE_DEACTIVATED_PLANTS}
      GROUP BY c.company_id, c.name, c.company_tier
      ORDER BY "operationalDevices" DESC`);

    const plants = await this.prisma.$queryRaw<
      Array<RawFleetCounts & { plantId: string; name: string; companyId: string | null; companyName: string | null; zoneName: string | null; lastSnapshotAt: Date | null; lastActivityAt: Date | null }>
    >(Prisma.sql`
      SELECT p.plant_id::text AS "plantId", p.name AS "name",
             c.company_id::text AS "companyId", c.name AS "companyName",
             z.name AS "zoneName", ${FLEET_COUNT_COLUMNS}, ${freshness}
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      LEFT JOIN company_master c ON c.company_id = ds.company_id
      WHERE true ${zoneFilter} ${EXCLUDE_DEACTIVATED_PLANTS}
      GROUP BY p.plant_id, p.name, c.company_id, c.name, z.name
      ORDER BY "operationalDevices" DESC`);

    return {
      companies: companies.map(({ lastSnapshotAt, lastActivityAt, ...r }) => ({
        ...r,
        ...withRates(r),
        lastSnapshotAt: lastSnapshotAt?.toISOString() ?? null,
        lastActivityAt: lastActivityAt?.toISOString() ?? null,
      })),
      plants: plants.map(({ lastSnapshotAt, lastActivityAt, ...r }) => ({
        ...r,
        ...withRates(r),
        lastSnapshotAt: lastSnapshotAt?.toISOString() ?? null,
        lastActivityAt: lastActivityAt?.toISOString() ?? null,
      })),
    };
  }

  async companyPlantOverview(
    scope: ZoneScope,
    filters: { companyId?: string; plantId?: string; zoneId?: string } = {},
  ): Promise<CompanyPlantRow[]> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const conds: Prisma.Sql[] = [];
    if (restrictZone !== null) conds.push(Prisma.sql`AND z.zone_id = ${BigInt(restrictZone)}`);
    // Caller-requested zone (the Device Detail zone drill-down). Additive to — never instead of —
    // the ZM clamp above: a ZM asking for another zone still gets their own, because both predicates
    // are ANDed and the pair is unsatisfiable. The global ZoneScopeGuard does not fire here (it reads
    // `:zoneId` route params and the `zone_id` query spelling), so the clamp must live in the service,
    // exactly as `activityTrend` does it.
    if (filters.zoneId && /^\d+$/.test(filters.zoneId))
      conds.push(Prisma.sql`AND z.zone_id = ${BigInt(filters.zoneId)}`);
    if (filters.companyId && /^\d+$/.test(filters.companyId))
      conds.push(Prisma.sql`AND c.company_id = ${BigInt(filters.companyId)}`);
    if (filters.plantId && /^\d+$/.test(filters.plantId))
      conds.push(Prisma.sql`AND p.plant_id = ${BigInt(filters.plantId)}`);
    const extra = conds.length ? Prisma.join(conds, ' ') : Prisma.empty;

    // Rows are driven by the COUNTS query (every company×plant with a mirrored device on a live
    // plant), not by the inactive query — a plant at 100% health used to disappear from this table
    // entirely, taking its operational devices out of the column totals and breaking
    // `Σ company.operationalDevices == Σ zone.operationalDevices`.
    const counts = await this.prisma.$queryRaw<
      Array<RawFleetCounts & { companyId: string; companyName: string; companyTier: string; zoneId: string; plantId: string; plantName: string }>
    >(Prisma.sql`
      SELECT c.company_id::text AS "companyId", c.name AS "companyName",
             c.company_tier::text AS "companyTier", z.zone_id::text AS "zoneId",
             p.plant_id::text AS "plantId", p.name AS "plantName", ${FLEET_COUNT_COLUMNS}
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      JOIN company_master c ON c.company_id = ds.company_id
      WHERE true ${extra} ${EXCLUDE_DEACTIVATED_PLANTS}
      GROUP BY c.company_id, c.name, c.company_tier, z.zone_id, p.plant_id, p.name
      ORDER BY c.company_tier, c.name, p.name`);

    // The per-bucket split of the same inactive population, imported predicate + identical scope.
    const grouped = await this.prisma.$queryRaw<CompanyPlantGroupedRow[]>(Prisma.sql`
      SELECT c.company_id::text AS "companyId", c.name AS "companyName",
             c.company_tier::text AS "companyTier", z.zone_id::text AS "zoneId",
             p.plant_id::text AS "plantId", p.name AS "plantName",
             ds.sla_bucket::text AS "slaBucket", COUNT(*)::int AS "count"
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      JOIN company_master c ON c.company_id = ds.company_id
      WHERE ${INACTIVE_OPERATIONAL}
        ${extra} ${EXCLUDE_DEACTIVATED_PLANTS}
      GROUP BY c.company_id, c.name, c.company_tier, z.zone_id, p.plant_id, p.name, ds.sla_bucket`);

    const byKey = new Map<string, CompanyPlantRow>();
    for (const { companyId, companyName, companyTier, zoneId, plantId, plantName, ...raw } of counts) {
      byKey.set(`${companyId}:${plantId}`, {
        companyId,
        companyName,
        companyTier,
        zoneId,
        plantId,
        plantName,
        ...withRates(raw),
        byBucket: {},
      });
    }
    for (const r of grouped) {
      const row = byKey.get(`${r.companyId}:${r.plantId}`);
      if (row) row.byBucket[r.slaBucket] = r.count;
    }
    return [...byKey.values()];
  }

  /**
   * The operational half of the zone drill-down: how the zone's open work is currently *held* —
   * assigned vs not, across how many live batches, by how many SEs.
   *
   * This exists because nothing served it. `/api/tickets` has no zone filter and caps at 500 rows,
   * `/dispatch-runs/*` describes a past run rather than the zone's current state, and `/devices`
   * carries assignment per row but offers no aggregate — so an assignment count could previously only
   * be obtained by paging the whole zone client-side and summing, which is wrong for a pan-India role.
   *
   * `status` scopes this the same way it scopes every other band on the drill-down page, by filtering
   * the ticket's DEVICE against the shared inactive predicate (`FLEET_COUNT_COLUMNS`' definition, not
   * a second spelling of it):
   *   - INACTIVE — open work on devices that are still silent (the ordinary reading)
   *   - ACTIVE   — open work on devices that have since come back: real, and worth seeing
   *   - ALL      — every live ticket in the zone
   *
   * "Live" means the same not-closed/not-failed status set the Device Detail list already uses, and a
   * batch link means the same `removed_at IS NULL` row — so this aggregate and that table's per-row
   * assignment column cannot disagree about what is assigned.
   */
  async zoneOperations(
    scope: ZoneScope,
    filters: { zoneId?: string; status?: DeviceStatusScope } = {},
  ): Promise<ZoneOperationsSummary> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const conds: Prisma.Sql[] = [];
    if (restrictZone !== null) conds.push(Prisma.sql`AND z.zone_id = ${BigInt(restrictZone)}`);
    if (filters.zoneId && /^\d+$/.test(filters.zoneId))
      conds.push(Prisma.sql`AND z.zone_id = ${BigInt(filters.zoneId)}`);
    // The SAME predicates FLEET_COUNT_COLUMNS uses, imported rather than respelled, so "inactive" and
    // "active" mean one thing platform-wide (#176) — and, since #223, so that `ACTIVE` stops returning
    // devices that have never reported. This filter was surface 2 of the six in `cross-analysis.md`
    // §2.3: all 913 NDD devices were returned under the healthy/active filter.
    if (filters.status === 'INACTIVE') conds.push(Prisma.sql`AND ${INACTIVE_OPERATIONAL}`);
    else if (filters.status === 'ACTIVE') conds.push(Prisma.sql`AND ${HEALTHY_OPERATIONAL}`);
    else if (filters.status === 'NEVER_REPORTED') conds.push(Prisma.sql`AND ${NEVER_REPORTED_OPERATIONAL}`);
    const extra = conds.length ? Prisma.join(conds, ' ') : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{
        openTickets: number;
        assigned: number;
        unassigned: number;
        liveBatches: number;
        overriddenBatches: number;
        engineersEngaged: number;
      }>
    >(Prisma.sql`
      SELECT COUNT(*)::int AS "openTickets",
             COUNT(*) FILTER (WHERE t.assignment_state = 'FORMALLY_ASSIGNED')::int AS "assigned",
             COUNT(*) FILTER (WHERE t.assignment_state = 'UNASSIGNED')::int AS "unassigned",
             COUNT(DISTINCT asg.batch_id)::int AS "liveBatches",
             COUNT(DISTINCT asg.batch_id) FILTER (WHERE asg.batch_status = 'OVERRIDDEN')::int AS "overriddenBatches",
             COUNT(DISTINCT asg.se_id)::int AS "engineersEngaged"
      FROM tickets t
      JOIN device_states ds ON ds.device_id = t.device_id
      JOIN plants p ON p.plant_id = t.plant_id
      JOIN zones z ON z.zone_id = p.zone_id
      LEFT JOIN LATERAL (
        SELECT pba.batch_id, pba.status AS batch_status, pba.se_id
        FROM batch_assignment_tickets bat
        JOIN plant_batch_assignments pba ON pba.batch_id = bat.batch_id
        WHERE bat.ticket_id = t.ticket_id AND bat.removed_at IS NULL
        ORDER BY bat.created_at DESC
        LIMIT 1
      ) asg ON true
      WHERE t.status NOT IN (${Prisma.join([...CLOSED_TICKET_STATUSES])})
        ${extra} ${EXCLUDE_DEACTIVATED_PLANTS}`);

    const r = rows[0];
    return {
      openTickets: r?.openTickets ?? 0,
      assigned: r?.assigned ?? 0,
      unassigned: r?.unassigned ?? 0,
      liveBatches: r?.liveBatches ?? 0,
      overriddenBatches: r?.overriddenBatches ?? 0,
      engineersEngaged: r?.engineersEngaged ?? 0,
    };
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
