import { ForbiddenException, Injectable } from '@nestjs/common';
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
 * permanently. Measured on the dev mirror: 0 of 24,294 rows populated. It is provenance, not outcome;
 * a reader that required both columns to agree would report zero commissioned devices forever.
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
      ${this.gradedSource({ since: cohortStart, until: now, restrictZone, plantId: opts.plantId, remarks: opts.remarks })}
      SELECT
        GROUPING(plant_id)::int AS "gPlant",
        GROUPING(installed_by)::int AS "gInstaller",
        plant_id::text AS "plantId", zone_id::text AS "zoneId", plant_name AS "plantName",
        installed_by AS "installerKey",
        count(*)::int AS fitments,
        count(*) FILTER (WHERE commissioned)::int AS online,
        -- Silent INSIDE the grace window is pending, not failed. 96.97% of genuine new installations
        -- report within 12–24h, so treating the grace population as defective cries wolf on the
        -- majority. Past the window and still silent is the actual defect.
        count(*) FILTER (WHERE NOT commissioned AND installed_at > ${graceCutoff})::int AS pending,
        count(*) FILTER (WHERE NOT commissioned AND installed_at <= ${graceCutoff})::int AS failed,
        count(ttfr_hours)::int AS "ttfrSample",
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY ttfr_hours))::float8 AS "medianHours",
        (percentile_cont(0.95) WITHIN GROUP (ORDER BY ttfr_hours))::float8 AS "p95Hours"
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
      },
      // An absent grand-total row means an empty population, which is a legitimate answer here — see
      // EMPTY_COHORT for why that is a named constant rather than a computed zero.
      totals: totalsRow ? counts(totalsRow) : EMPTY_COHORT,
      byPlant: rows
        .filter((r) => r.gPlant === 0)
        .map((r) => ({ plantId: r.plantId!, plantName: r.plantName!, zoneId: r.zoneId!, ...counts(r) }))
        .sort(byFitments),
      byInstaller: rows
        .filter((r) => r.gInstaller === 0)
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
    const ordering =
      opts.sort === 'neverOnlineRate'
        ? Prisma.sql`(count(*) FILTER (WHERE NOT commissioned))::numeric / count(*) DESC, count(*) DESC`
        : Prisma.sql`count(*) DESC`;

    const rows = await this.prisma.$queryRaw<RawQualityRow[]>(Prisma.sql`
      ${this.gradedSource({ since, until: now, restrictZone, plantId: opts.plantId, remarks: opts.remarks })}
      SELECT ${keyColumns},
        count(*)::int AS installs,
        -- The exact complement of the commissioned flag, not a second definition of it. If this
        -- drifted from the cohort endpoint the two surfaces would disagree about "came online".
        count(*) FILTER (WHERE NOT commissioned)::int AS "neverOnline",
        count(DISTINCT plant_id)::int AS "distinctPlants",
        -- Pinned to UTC rather than the session zone so "one afternoon" means the same thing wherever
        -- this runs.
        count(DISTINCT (installed_at AT TIME ZONE 'UTC')::date)::int AS "distinctInstallDays",
        min(installed_at) AS "firstInstallAt",
        max(installed_at) AS "lastInstallAt",
        count(ttfr_hours)::int AS "ttfrSample",
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY ttfr_hours))::float8 AS "medianHours",
        (percentile_cont(0.95) WITHIN GROUP (ORDER BY ttfr_hours))::float8 AS "p95Hours"
      FROM graded
      GROUP BY ${groupColumns}
      HAVING count(*) >= ${opts.minInstalls}
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
   */
  private gradedSource(opts: {
    since: Date;
    until: Date;
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

    return Prisma.sql`
      WITH scoped AS (
        SELECT dc.plant_id, p.zone_id, p.name AS plant_name, dc.installed_by, dc.installed_at,
               ds.first_reported_at
        FROM device_commissioning dc
        JOIN plants p ON p.plant_id = dc.plant_id
        -- LEFT: a fitment whose device has no state row yet is silent, not missing from the cohort.
        LEFT JOIN device_states ds ON ds.device_id = dc.device_id
        WHERE dc.installed_at >= ${opts.since} AND dc.installed_at <= ${opts.until}
        ${Prisma.join(filters, ' ')}
      ),
      graded AS (
        SELECT plant_id, zone_id, plant_name, installed_by, installed_at,
               (first_reported_at IS NOT NULL AND first_reported_at >= installed_at) AS commissioned,
               -- Timing derives from the same predicate as the commissioned flag above — one
               -- definition, not two — and is additionally gated on the epoch. Before it,
               -- first_reported_at holds a last-seen value, which yields a median of ~8,707 hours
               -- on real data. NULL here means "not measurable", so count(ttfr_hours) is the
               -- honest sample size.
               CASE
                 WHEN first_reported_at IS NOT NULL
                  AND first_reported_at >= installed_at
                  AND installed_at >= ${this.config.ttfrEpoch}
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

export interface CohortOptions {
  cohortDays: number;
  graceHours: number;
  zoneId: bigint | null;
  plantId: bigint | null;
  remarks: string[] | null;
}

export interface InstallQualityOptions {
  lookbackDays: number;
  groupBy: InstallQualityGroupBy;
  sort: InstallQualitySort;
  minInstalls: number;
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
  filters: { zoneId: string | null; plantId: string | null; remarks: string[] | null };
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
  filters: { zoneId: string | null; plantId: string | null; remarks: string[] | null; minInstalls: number };
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
