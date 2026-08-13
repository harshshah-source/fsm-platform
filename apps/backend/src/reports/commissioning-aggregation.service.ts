import { ForbiddenException, Injectable } from '@nestjs/common';
import { EXCLUDE_DEACTIVATED_PLANTS } from '../dashboard/dashboard.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { readCommissioningConfig, type CommissioningConfig } from './commissioning.config';
import { classifyInstaller, type InstallerKind } from './installer-classification';

/**
 * Commissioning cohort + install quality (`/api/reports/commissioning/*`).
 *
 * An INSTALL-QUALITY measure, not a fault queue: "of the devices fitted in the last N days, how many
 * came online, how long did each take, and which haven't?" A device fitted three days ago that is
 * already reporting belongs in this view as a success — the denominator matters as much as the
 * numerator, which is why every shape here reports `fitments` alongside its outcome split.
 *
 * **No new module, no new table.** These are the same rows the master sync already appends to
 * `device_commissioning` (Feasibility §7.3) joined to the `device_states` the telemetry tick already
 * maintains. A parallel module would recreate the `is_departed`/`vehicles.status` drift risk. Cohort
 * membership is DERIVED — `installed_at >= now() - N days` is the whole predicate. Nothing moves a
 * device between states, and a device ageing out of the window requires no write.
 *
 * **Where `online` comes from, and where it does NOT.** Online is decided solely by
 * `device_states.first_reported_at`. `device_commissioning.first_reported_at` is a snapshot taken at
 * OBSERVATION time (`master-sync.service.ts:481` — "a later first ping does not retro-fill an older
 * row"), so for a genuinely new fitment the device has not reported yet and the value is null
 * permanently. Measured on the dev mirror: 371 of 25,387 rows populated — the non-zero rows are later
 * runs snapshotting devices that have since begun reporting, which is exactly why it is provenance and
 * not outcome. A reader that required both columns to agree would report almost nothing as commissioned.
 *
 * **Which devices are IN the measure — see {@link CommissioningPopulation} (#233).** Every count here
 * defaults to the operational fleet, the same population every rate on the dashboard is taken over.
 * Before #233 there was no such predicate and a device returned to a warehouse was counted as a failed
 * install: measured live over 90 days, 6,832 fitments / 2,668 failed (39.1%) against 2,645 / 147 (5.6%)
 * once departed devices are excluded, because 4,127 of the 6,405 cohort devices were departed.
 */
@Injectable()
export class CommissioningAggregationService {
  private readonly config: CommissioningConfig;

  constructor(private readonly prisma: PrismaService) {
    this.config = readCommissioningConfig();
  }

  /**
   * The live cohort — fitments inside `cohortDays`, split into online / pending / failed, with the
   * per-plant and per-installer breakdowns computed in the SAME pass (see {@link gradedSource}).
   */
  async cohort(scope: ReportScope, opts: CohortOptions, now: Date = new Date()): Promise<CommissioningCohortReport> {
    const restrictZone = this.resolveZone(scope, opts.zoneId);
    const cohortStart = new Date(now.getTime() - opts.cohortDays * 24 * 3_600_000);
    const graceCutoff = new Date(now.getTime() - opts.graceHours * 3_600_000);

    const rows = await this.prisma.$queryRaw<RawCohortRow[]>(Prisma.sql`
      ${this.gradedSource({ since: cohortStart, until: now, population: opts.population, restrictZone, plantId: opts.plantId, remarks: opts.remarks })}
      SELECT
        GROUPING(plant_id)::int AS "gPlant",
        GROUPING(installed_by)::int AS "gInstaller",
        plant_id::text AS "plantId", zone_id::text AS "zoneId", plant_name AS "plantName",
        installed_by AS "installerKey",
        count(*) FILTER (WHERE in_population)::int AS fitments,
        count(*) FILTER (WHERE in_population AND commissioned)::int AS online,
        -- Silent INSIDE the grace window is pending, not failed. 96.97% of genuine new installations
        -- report within 12–24h, so treating the grace population as defective cries wolf on the
        -- majority. Past the window and still silent is the actual defect.
        count(*) FILTER (WHERE in_population AND NOT commissioned AND installed_at > ${graceCutoff})::int AS pending,
        count(*) FILTER (WHERE in_population AND NOT commissioned AND installed_at <= ${graceCutoff})::int AS failed,
        -- No in_population filter needed: ttfr_hours is already null outside the population, in the
        -- same CASE that gates the epoch. One gate, not two spellings of it.
        count(ttfr_hours)::int AS "ttfrSample",
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY ttfr_hours))::float8 AS "medianHours",
        (percentile_cont(0.95) WITHIN GROUP (ORDER BY ttfr_hours))::float8 AS "p95Hours",
        -- The census is deliberately NOT population-filtered: it is what names the drop between the
        -- fitments in the window and the fitments in the measure. Only the grand-total row is read.
        count(*)::int AS "censusFitments",
        count(*) FILTER (WHERE operational)::int AS "censusOperational",
        count(*) FILTER (WHERE warehouse)::int AS "censusWarehouse",
        count(*) FILTER (WHERE unmirrored)::int AS "censusUnmirrored"
      FROM graded
      -- One pass, three shapes. Three separate queries would each evaluate their own window boundary
      -- and could disagree about a device sitting exactly on the grace line; GROUPING SETS makes the
      -- totals and the breakdowns consistent by construction.
      GROUP BY GROUPING SETS ((), (plant_id, zone_id, plant_name), (installed_by))`);

    const totalsRow = rows.find((r) => r.gPlant === 1 && r.gInstaller === 1);

    return {
      cohortDays: opts.cohortDays,
      graceHours: opts.graceHours,
      cohortStart: cohortStart.toISOString(),
      generatedAt: now.toISOString(),
      scopedToZoneId: scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? String(scope.zoneId) : null,
      filters: {
        zoneId: restrictZone != null ? String(restrictZone) : null,
        plantId: opts.plantId != null ? String(opts.plantId) : null,
        remarks: opts.remarks ?? null,
        population: opts.population,
      },
      population: totalsRow ? census(totalsRow) : EMPTY_CENSUS,
      // An absent grand-total row means an empty population, which is a legitimate answer here — see
      // EMPTY_COHORT for why that is a named constant rather than a computed zero.
      totals: totalsRow ? counts(totalsRow) : EMPTY_COHORT,
      // A group whose every fitment fell outside the population is dropped rather than rendered as a
      // row of zeroes. Under `population=all` nothing can be filtered out, so this is a no-op there —
      // it exists so the operational view does not list plants that contributed nothing to it.
      byPlant: rows
        .filter((r) => r.gPlant === 0 && r.fitments > 0)
        .map((r) => ({ plantId: r.plantId!, plantName: r.plantName!, zoneId: r.zoneId!, ...counts(r) }))
        .sort(byFitments),
      byInstaller: rows
        .filter((r) => r.gInstaller === 0 && r.fitments > 0)
        .map((r) => ({ installerKey: r.installerKey, installerKind: classifyInstaller(r.installerKey), ...counts(r) }))
        .sort(byFitments),
    };
  }

  /**
   * Install quality over a longer lookback — the surface where a systemic onboarding defect shows up
   * as a row rather than as an anecdote. `distinctInstallDays` is deliberately a first-class column:
   * "many installs, one afternoon, none online" is a shape, and a shape can be sorted on. Encoding a
   * particular installer's name would not generalise to the next one.
   */
  async installQuality(scope: ReportScope, opts: InstallQualityOptions, now: Date = new Date()): Promise<InstallQualityReport> {
    const restrictZone = this.resolveZone(scope, opts.zoneId);
    const since = new Date(now.getTime() - opts.lookbackDays * 24 * 3_600_000);
    const byPlant = opts.groupBy === 'plant';

    const keyColumns = byPlant
      ? Prisma.sql`plant_id::text AS "plantId", zone_id::text AS "zoneId", plant_name AS "plantName"`
      : Prisma.sql`installed_by AS "installerKey"`;
    const groupColumns = byPlant ? Prisma.sql`plant_id, zone_id, plant_name` : Prisma.sql`installed_by`;
    // Every aggregate below is population-filtered, so the ordering has to be too — otherwise the
    // worst-first sort would rank on a rate nobody can see in the table beside it.
    const ordering =
      opts.sort === 'neverOnlineRate'
        ? Prisma.sql`(count(*) FILTER (WHERE in_population AND NOT commissioned))::numeric / count(*) FILTER (WHERE in_population) DESC, count(*) FILTER (WHERE in_population) DESC`
        : Prisma.sql`count(*) FILTER (WHERE in_population) DESC`;

    const rows = await this.prisma.$queryRaw<RawQualityRow[]>(Prisma.sql`
      ${this.gradedSource({ since, until: now, population: opts.population, restrictZone, plantId: opts.plantId, remarks: opts.remarks })}
      SELECT ${keyColumns},
        count(*) FILTER (WHERE in_population)::int AS installs,
        -- The exact complement of the commissioned flag, not a second definition of it. If this
        -- drifted from the cohort endpoint the two surfaces would disagree about "came online".
        count(*) FILTER (WHERE in_population AND NOT commissioned)::int AS "neverOnline",
        count(DISTINCT plant_id) FILTER (WHERE in_population)::int AS "distinctPlants",
        -- Pinned to UTC rather than the session zone so "one afternoon" means the same thing wherever
        -- this runs.
        count(DISTINCT (installed_at AT TIME ZONE 'UTC')::date) FILTER (WHERE in_population)::int AS "distinctInstallDays",
        min(installed_at) FILTER (WHERE in_population) AS "firstInstallAt",
        max(installed_at) FILTER (WHERE in_population) AS "lastInstallAt",
        count(ttfr_hours)::int AS "ttfrSample",
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY ttfr_hours))::float8 AS "medianHours",
        (percentile_cont(0.95) WITHIN GROUP (ORDER BY ttfr_hours))::float8 AS "p95Hours"
      FROM graded
      GROUP BY ${groupColumns}
      -- The floor is >= 1, so a group with no in-population fitments drops out here and needs no
      -- second filter in TypeScript — unlike the cohort's breakdowns, which have no HAVING.
      HAVING count(*) FILTER (WHERE in_population) >= ${opts.minInstalls}
      ORDER BY ${ordering}`);

    return {
      lookbackDays: opts.lookbackDays,
      since: since.toISOString(),
      generatedAt: now.toISOString(),
      groupBy: opts.groupBy,
      scopedToZoneId: scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? String(scope.zoneId) : null,
      filters: {
        zoneId: restrictZone != null ? String(restrictZone) : null,
        plantId: opts.plantId != null ? String(opts.plantId) : null,
        remarks: opts.remarks ?? null,
        minInstalls: opts.minInstalls,
        population: opts.population,
      },
      rows: rows.map((r) => quality(r, byPlant)),
    };
  }

  /**
   * The scoped, GRADED fitment population — every query above opens with this and selects from
   * `graded`.
   *
   * The single most important line in this file is the `commissioned` expression. It lives HERE, in
   * SQL, computed once, and both endpoints' counts and both endpoints' timing samples derive from it.
   * It is not recomputed in TypeScript anywhere, so there is no application path that can be bypassed
   * or that can drift from the other endpoint's idea of the same word.
   *
   * `first_reported_at >= installed_at` is the load-bearing half. A stamp EARLIER than the fitment it
   * belongs to is not evidence of coming online: 2,138 rows on the dev mirror are in exactly that
   * state, because the write-once COALESCE captured a pre-existing device's last-seen ping the first
   * time the tick ran after the column shipped. Without the comparison, a dead device that was
   * re-mapped onto a new vehicle reports as a successful install.
   *
   * `installed_at` being NULL (≈13% of source rows) drops out naturally — a fitment with no date
   * cannot be inside a time-bounded cohort, and `NULL >= since` is not true.
   *
   * **The population split (#233) is computed here and nowhere else.** `operational` is the same
   * predicate every rate on the dashboard is taken over, and `EXCLUDE_DEACTIVATED_PLANTS` is
   * IMPORTED from `dashboard.service.ts` rather than restated — a checker (or a report) written from
   * a second spelling only verifies that the second spelling agrees with itself, which is the exact
   * failure #176 closed. The three flags partition the window exactly, so the census the endpoints
   * publish is arithmetic rather than a claim.
   */
  private gradedSource(opts: {
    since: Date;
    until: Date;
    population: CommissioningPopulation;
    restrictZone: bigint | null;
    plantId: bigint | null;
    remarks: string[] | null;
  }): Prisma.Sql {
    const filters = [
      opts.restrictZone !== null ? Prisma.sql`AND p.zone_id = ${opts.restrictZone}` : Prisma.empty,
      opts.plantId !== null ? Prisma.sql`AND dc.plant_id = ${opts.plantId}` : Prisma.empty,
      opts.remarks !== null && opts.remarks.length > 0
        ? Prisma.sql`AND dc.installation_remark = ANY(${opts.remarks}::text[])`
        : Prisma.empty,
    ];

    // `EXCLUDE_DEACTIVATED_PLANTS` is authored as a WHERE-clause fragment (it opens with `AND`), so it
    // is anchored on TRUE to be usable as a bare boolean here. Anchoring is what lets it be imported
    // as-is instead of copied without its leading conjunction.
    const operational = Prisma.sql`(ds.device_id IS NOT NULL AND ds.is_departed = false AND (TRUE ${EXCLUDE_DEACTIVATED_PLANTS}))`;
    // Under `all` this is the literal TRUE, which is how `population=all` reproduces the pre-#233
    // numbers byte for byte — the regression floor, not a separate query path.
    const inPopulation = opts.population === 'all' ? Prisma.sql`TRUE` : Prisma.sql`operational`;

    return Prisma.sql`
      WITH scoped AS (
        SELECT dc.plant_id, p.zone_id, p.name AS plant_name, dc.installed_by, dc.installed_at,
               ds.first_reported_at,
               -- A commissioning fact deliberately carries no FKs (#227), so a fitment CAN outlive
               -- the mirror row for its device. That is a fourth outcome, not a departed device.
               (ds.device_id IS NULL) AS unmirrored,
               (ds.device_id IS NOT NULL AND ds.is_departed = true) AS warehouse,
               ${operational} AS operational
        FROM device_commissioning dc
        JOIN plants p ON p.plant_id = dc.plant_id
        -- LEFT: a fitment whose device has no state row yet is silent, not missing from the cohort.
        LEFT JOIN device_states ds ON ds.device_id = dc.device_id
        WHERE dc.installed_at >= ${opts.since} AND dc.installed_at <= ${opts.until}
        ${Prisma.join(filters, ' ')}
      ),
      graded AS (
        SELECT plant_id, zone_id, plant_name, installed_by, installed_at,
               unmirrored, warehouse, operational,
               ${inPopulation} AS in_population,
               (first_reported_at IS NOT NULL AND first_reported_at >= installed_at) AS commissioned,
               -- Timing derives from the same predicate as the commissioned flag above — one
               -- definition, not two — and is additionally gated on the epoch AND on the population.
               -- Before the epoch, first_reported_at holds a last-seen value, which yields a median
               -- of ~8,707 hours on real data. NULL here means "not measurable", so count(ttfr_hours)
               -- is the honest sample size and needs no FILTER of its own at any call site.
               CASE
                 WHEN first_reported_at IS NOT NULL
                  AND first_reported_at >= installed_at
                  AND installed_at >= ${this.config.ttfrEpoch}
                  AND ${inPopulation}
                 THEN EXTRACT(epoch FROM (first_reported_at - installed_at))::float8 / 3600.0
               END AS ttfr_hours
        FROM scoped
      )`;
  }

  /**
   * A ZONAL_MANAGER is pinned to their own zone. Unlike `ReportsService.rootCause`, which silently
   * overrides the requested zone, this REJECTS a cross-zone request — matching `ZoneScopeGuard`'s
   * `ZONE_SCOPE_VIOLATION`. Silently returning a different population than the one asked for is the
   * precise failure this view exists to avoid: an installer working three zones would otherwise show
   * three different failure rates with nothing marking any of them as partial.
   */
  private resolveZone(scope: ReportScope, requested: bigint | null): bigint | null {
    if (scope.role !== 'ZONAL_MANAGER') return requested;
    const own = scope.zoneId != null ? BigInt(scope.zoneId) : null;
    if (requested !== null && requested !== own) throw new ForbiddenException('ZONE_SCOPE_VIOLATION');
    return own;
  }
}

/**
 * The empty answer, as a named constant on its own code path.
 *
 * `medianHours: 0` and `medianHours: null` are not the same claim: zero says every device commissioned
 * the instant it was fitted, null says nothing was measured. On a page whose entire purpose is install
 * quality, the first is confidently wrong. {@link timing} branches on the sample size BEFORE it looks
 * at the aggregate, so the null answer is produced deliberately rather than inherited from whatever
 * `percentile_cont` happens to return over an empty input.
 */
export const NO_TIMING: CommissioningTiming = { medianHours: null, p95Hours: null, sampleSize: 0 };
const EMPTY_COHORT: CohortCounts = { fitments: 0, online: 0, pending: 0, failed: 0, ttfr: NO_TIMING };
const EMPTY_CENSUS: CommissioningPopulationCensus = {
  fitmentsInWindow: 0,
  operational: 0,
  warehouse: 0,
  deactivatedPlant: 0,
  unmirrored: 0,
};

/**
 * The population census — what the window held, and what each step dropped (#233 AC-4).
 *
 * `deactivatedPlant` is the REMAINDER rather than its own `count(*) FILTER`, and that is deliberate:
 * computed this way the four parts sum to `fitmentsInWindow` by construction, so the census cannot
 * claim a partition it does not have. A fifth category appearing at source would show up as a negative
 * remainder — visible — rather than as a silently unbalanced total.
 */
function census(row: RawCohortRow): CommissioningPopulationCensus {
  const { censusFitments, censusOperational, censusWarehouse, censusUnmirrored } = row;
  return {
    fitmentsInWindow: censusFitments,
    operational: censusOperational,
    warehouse: censusWarehouse,
    deactivatedPlant: censusFitments - censusOperational - censusWarehouse - censusUnmirrored,
    unmirrored: censusUnmirrored,
  };
}

/**
 * Build a timing block. The zero-sample case is a distinct branch — see {@link NO_TIMING}.
 *
 * The branch is on the SAMPLE SIZE and happens before either aggregate is read, so the null answer
 * does not depend on `percentile_cont` returning null over an empty input. It happens to do so, but
 * relying on that would make the difference between "no data" and "commissioned instantly" a property
 * of Postgres rather than of this code. Exported so that independence is directly testable.
 */
export function timing(sampleSize: number, medianHours: number | null, p95Hours: number | null): CommissioningTiming {
  if (sampleSize <= 0) return NO_TIMING;
  return { medianHours: round2(medianHours), p95Hours: round2(p95Hours), sampleSize };
}

function round2(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

function counts(row: RawCohortRow): CohortCounts {
  return {
    fitments: row.fitments,
    online: row.online,
    pending: row.pending,
    failed: row.failed,
    ttfr: timing(row.ttfrSample, row.medianHours, row.p95Hours),
  };
}

function quality(row: RawQualityRow, byPlant: boolean): InstallQualityRow {
  const metrics: InstallQualityMetrics = {
    installs: row.installs,
    neverOnline: row.neverOnline,
    // Guarded rather than assumed: the HAVING floor is >= 1 today, but a zero here would be a silent
    // NaN in the payload rather than a visible failure.
    neverOnlineRate: row.installs > 0 ? Math.round((row.neverOnline / row.installs) * 1000) / 1000 : 0,
    firstInstallAt: row.firstInstallAt?.toISOString() ?? null,
    lastInstallAt: row.lastInstallAt?.toISOString() ?? null,
    distinctPlants: row.distinctPlants,
    distinctInstallDays: row.distinctInstallDays,
    ttfr: timing(row.ttfrSample, row.medianHours, row.p95Hours),
  };
  return byPlant
    ? { plantId: row.plantId!, plantName: row.plantName!, zoneId: row.zoneId!, ...metrics }
    : { installerKey: row.installerKey ?? null, installerKind: classifyInstaller(row.installerKey), ...metrics };
}

function byFitments(a: CohortCounts, b: CohortCounts): number {
  return b.fitments - a.fitments;
}

interface ReportScope {
  role: string;
  zoneId: number | null;
}

/**
 * Which fitments are IN the measure (#233).
 *
 * `operational` is the default and is the same population every rate on the dashboard is taken over:
 * `device_states.is_departed = false`, on a plant that is not deactivated. A device returned to a
 * warehouse is silent because it is in a box — counting it as a failed install is the defect #176
 * closed on the dashboard and this filter closes here.
 *
 * `all` drops the predicate entirely and reproduces the pre-#233 numbers exactly. It is for
 * reconciliation and audit — walking a figure back to every fitment the window held — and is the
 * regression floor for the existing specs, not a second measure with its own meaning.
 */
export type CommissioningPopulation = 'operational' | 'all';

/**
 * Every fitment in the window, and where each one went. Reported alongside the counts so the drop
 * between "fitments AutoPlant recorded" and "fitments this measure is over" is NAMED rather than
 * silent — the same rule the Fleet Composition funnel follows.
 *
 * The four parts sum to `fitmentsInWindow` — see {@link census}.
 */
export interface CommissioningPopulationCensus {
  /** Fitments matching the window and every non-population filter (zone / plant / remark). */
  fitmentsInWindow: number;
  /** In the field: `is_departed = false`, plant live. The `operational` population. */
  operational: number;
  /** Returned to a warehouse — an open `device_departures` row. Silent by circumstance, not by fault. */
  warehouse: number;
  /** On a plant deactivated under #119. Excluded from every other dashboard count for the same reason. */
  deactivatedPlant: number;
  /** No `device_states` row at all — the fitment outlived the mirror (#227). Not the same as departed. */
  unmirrored: number;
}

export interface CohortOptions {
  cohortDays: number;
  graceHours: number;
  population: CommissioningPopulation;
  zoneId: bigint | null;
  plantId: bigint | null;
  remarks: string[] | null;
}

export interface InstallQualityOptions {
  lookbackDays: number;
  groupBy: InstallQualityGroupBy;
  sort: InstallQualitySort;
  minInstalls: number;
  population: CommissioningPopulation;
  zoneId: bigint | null;
  plantId: bigint | null;
  remarks: string[] | null;
}

export type InstallQualityGroupBy = 'installer' | 'plant';
export type InstallQualitySort = 'installs' | 'neverOnlineRate';

export interface CommissioningTiming {
  /** Hours from fitment to first report. Null when nothing in this group was measurable. */
  medianHours: number | null;
  p95Hours: number | null;
  /** How many fitments actually contributed. Excludes pre-epoch installs — see `commissioning.config`. */
  sampleSize: number;
}

export interface CohortCounts {
  fitments: number;
  online: number;
  /** Silent, still inside the grace window. Not yet a defect. */
  pending: number;
  /** Silent, past the grace window. A defect. */
  failed: number;
  ttfr: CommissioningTiming;
}

export interface CohortPlantRow extends CohortCounts {
  plantId: string;
  plantName: string;
  zoneId: string;
}

export interface CohortInstallerRow extends CohortCounts {
  installerKey: string | null;
  installerKind: InstallerKind;
}

export interface CommissioningCohortReport {
  cohortDays: number;
  graceHours: number;
  cohortStart: string;
  generatedAt: string;
  /** Non-null only when the viewer is CLAMPED (a ZM). The UI renders its caveat off this. */
  scopedToZoneId: string | null;
  filters: { zoneId: string | null; plantId: string | null; remarks: string[] | null; population: CommissioningPopulation };
  /** What the window held and what each step dropped. `totals.fitments` equals the selected part. */
  population: CommissioningPopulationCensus;
  totals: CohortCounts;
  byPlant: CohortPlantRow[];
  byInstaller: CohortInstallerRow[];
}

export interface InstallQualityMetrics {
  installs: number;
  neverOnline: number;
  /** `neverOnline / installs`, 0–1, 3 decimals. */
  neverOnlineRate: number;
  firstInstallAt: string | null;
  lastInstallAt: string | null;
  distinctPlants: number;
  /** Distinct UTC calendar days. 1 across many installs is the one-afternoon signature. */
  distinctInstallDays: number;
  ttfr: CommissioningTiming;
}

export type InstallQualityRow =
  | (InstallQualityMetrics & { installerKey: string | null; installerKind: InstallerKind })
  | (InstallQualityMetrics & { plantId: string; plantName: string; zoneId: string });

export interface InstallQualityReport {
  lookbackDays: number;
  since: string;
  generatedAt: string;
  groupBy: InstallQualityGroupBy;
  scopedToZoneId: string | null;
  filters: {
    zoneId: string | null;
    plantId: string | null;
    remarks: string[] | null;
    minInstalls: number;
    population: CommissioningPopulation;
  };
  rows: InstallQualityRow[];
}

interface RawCohortRow {
  gPlant: number;
  gInstaller: number;
  plantId: string | null;
  zoneId: string | null;
  plantName: string | null;
  installerKey: string | null;
  fitments: number;
  online: number;
  pending: number;
  failed: number;
  ttfrSample: number;
  medianHours: number | null;
  p95Hours: number | null;
  /** Population census — meaningful only on the grand-total row; see {@link census}. */
  censusFitments: number;
  censusOperational: number;
  censusWarehouse: number;
  censusUnmirrored: number;
}

interface RawQualityRow {
  plantId?: string | null;
  zoneId?: string | null;
  plantName?: string | null;
  installerKey?: string | null;
  installs: number;
  neverOnline: number;
  distinctPlants: number;
  distinctInstallDays: number;
  firstInstallAt: Date | null;
  lastInstallAt: Date | null;
  ttfrSample: number;
  medianHours: number | null;
  p95Hours: number | null;
}
