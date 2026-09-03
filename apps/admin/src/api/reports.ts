// Typed client for the `/api/reports/*` read surface (Issues 39/40). Mirrors the backend
// ReportsService view types. Token comes from the same sessionStorage key AuthProvider writes.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

// Shared `authHeaders()` — the bearer plus `X-Acting-As-Zone`, so the Fleet Uptime hero KPI follows a
// CSM / OH into acting mode instead of reporting pan-India uptime on a zone dashboard.
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as T;
}

// ---- Report freshness (#347) ---------------------------------------------------

/**
 * Every report payload carries `dataAsOf` — **when the data was computed**, not when the browser drew
 * it. For the four cube-backed reports it is `MAX(computed_at)` over the rows that report actually
 * read, and `null` when the window has no cube row at all; for the two live distributions it is the
 * instant the server ran the query.
 *
 * #347. Before this, the Reports page stamped `new Date()` at the moment its fetch resolved and
 * labelled it "Data as of". That stamp could not go stale, by construction: a cube cron dead for two
 * days still produced a timestamp from this morning, over two-day-old numbers, and a manager acted on
 * them. A number with no honest stamp is worse than no number.
 */
export interface DataAsOf {
  dataAsOf: string | null;
}

export type ReportFreshnessState = 'fresh' | 'stale' | 'missing';

/**
 * Every cube behind a report is rebuilt by a **daily** sweep — `business-system-efficiency` (01:30),
 * `business-fleet-uptime` (03:00), `business-root-cause` (03:15), `business-zm-performance` (03:30),
 * all `0 H * * *`-shaped since #346 made the three monthly cubes cover the in-flight month. So 24h is
 * the expected cadence for all four and one threshold serves them.
 */
export const REPORT_CUBE_CADENCE_HOURS = 24;

/**
 * Stale past **two** missed cadences, the same `× 2` rule the ingestion detectors use: one skipped run
 * is a late cron or a long recompute, two is a stopped one. The doubling is what stops the badge
 * crying wolf every morning between the sweep's window opening and its actually finishing — a
 * threshold that fires on noise is one operators learn to ignore, which is the same outcome as having
 * none.
 */
export const REPORT_STALE_AFTER_HOURS = REPORT_CUBE_CADENCE_HOURS * 2;
export const REPORT_STALE_AFTER_MS = REPORT_STALE_AFTER_HOURS * 3_600_000;

/** What a report surface says when no cube row exists — never a blank, never a client-clock stamp. */
export const NO_CUBE_LABEL = 'No cube computed yet';

export interface ReportFreshness {
  state: ReportFreshnessState;
  /** Parsed stamp, or `null` when the report carries none. */
  asOf: Date | null;
  /** Age at `now`, clamped at 0 — a cube stamped slightly in the future is not "negative age". */
  ageMs: number | null;
  /** The rendered stamp line: `Data as of …`, or {@link NO_CUBE_LABEL}. */
  label: string;
}

/** `11 Jun 2026, 10:30 am` — the reference band's shape, in the viewer's locale. */
function formatAsOf(asOf: Date): string {
  return asOf.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** How old, in the coarsest unit that still answers "should I trust this?". */
export function reportAgeLabel(ageMs: number): string {
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 1) return 'under an hour old';
  if (hours < 48) return `${hours}h old`;
  return `${Math.floor(hours / 24)} days old`;
}

/**
 * The ONE place a report surface decides whether the number in front of the reader is current. An
 * unparseable or absent stamp is `missing` rather than silently `fresh`: the two failure modes this
 * closes both looked like freshness, and defaulting to "fine" is how they stayed invisible.
 */
export function reportFreshness(dataAsOf: string | null | undefined, now: Date = new Date()): ReportFreshness {
  const asOf = dataAsOf ? new Date(dataAsOf) : null;
  if (asOf === null || Number.isNaN(asOf.getTime())) {
    return { state: 'missing', asOf: null, ageMs: null, label: NO_CUBE_LABEL };
  }
  const ageMs = Math.max(0, now.getTime() - asOf.getTime());
  return {
    state: ageMs > REPORT_STALE_AFTER_MS ? 'stale' : 'fresh',
    asOf,
    ageMs,
    label: `Data as of ${formatAsOf(asOf)}`,
  };
}

// ---- Fleet Uptime % (Issue 39) -------------------------------------------------

export type FleetUptimeGroupBy = 'zone' | 'company' | 'plant';

/**
 * `uptimePct` is `null` when the group has **no eligible device-time** in the month — an empty cube,
 * or a month that has not elapsed (#346). It is deliberately not `0` and emphatically not `100`: the
 * uptime formula `(1 − downtime/window)` is undefined at a zero window, and the old backend answered
 * `100`, which reads as a perfect fleet. Every consumer must render "no data", not a number.
 */
export interface FleetUptimeRow {
  id: string;
  name: string;
  eligibleDeviceCount: number;
  uptimePct: number | null;
  autoRecoveryClosures: number;
  seRepairedClosures: number;
}

export interface FleetUptimeReport extends DataAsOf {
  month: string;
  groupBy: FleetUptimeGroupBy;
  fleet: {
    eligibleDeviceCount: number;
    uptimePct: number | null;
    autoRecoveryClosures: number;
    seRepairedClosures: number;
  };
  rows: FleetUptimeRow[];
}

export const apiFleetUptime = (params: { month?: string; groupBy?: FleetUptimeGroupBy } = {}) => {
  const q = new URLSearchParams();
  if (params.month) q.set('month', params.month);
  if (params.groupBy) q.set('groupBy', params.groupBy);
  const qs = q.toString();
  return get<FleetUptimeReport>(`/reports/fleet-uptime${qs ? `?${qs}` : ''}`);
};

/** The last `count` calendar months as `YYYY-MM`, oldest first (for the monthly trend fan-out). */
export function recentMonths(count: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** One month on the uptime trend. `null` is a **gap** — the month is on the axis, the line is not. */
export interface FleetUptimeTrendPoint {
  label: string;
  value: number | null;
}

/**
 * Fleet Uptime % monthly trend (Issue 39). The endpoint is single-month, so the trend is a fan-out of
 * the last `count` months.
 *
 * #346 — **every month keeps its place on the axis, whether or not it has a number.** This used to
 * `flatMap` failures away and plot `fleet.uptimePct` unguarded, which produced the worst of both
 * errors at once: months with no cube row were drawn at `100` (the backend's answer for a zero
 * window), and months whose request failed vanished, silently relabelling the axis so the reader
 * could not tell which six months they were looking at. A real trend read `100, 100, 100, 56.19,
 * 100, 100` — one real number in six.
 *
 * A point is a gap when the month has no eligible device-time (`eligibleDeviceCount === 0`, or a
 * `null` percentage) or when its request failed. The `eligibleDeviceCount` check is deliberate
 * belt-and-braces: an older backend still answers `100` here, and a percentage with an empty
 * denominator underneath it is not a percentage.
 */
export async function apiFleetUptimeTrend(count = 6, now: Date = new Date()): Promise<FleetUptimeTrendPoint[]> {
  const months = recentMonths(count, now);
  const settled = await Promise.allSettled(months.map((m) => apiFleetUptime({ month: m, groupBy: 'zone' })));
  return settled.map((r, i) => ({
    label: months[i].slice(2),
    value: r.status === 'fulfilled' ? fleetUptimeOrGap(r.value) : null,
  }));
}

/** The one place "does this report actually carry an uptime?" is decided, for KPI, bars and trend. */
export function fleetUptimeOrGap(report: FleetUptimeReport | null | undefined): number | null {
  if (!report || !report.fleet) return null;
  if (report.fleet.eligibleDeviceCount <= 0) return null;
  return report.fleet.uptimePct;
}

// ---- Soft Inactive Count trend (Issue 40, Operations Head) ---------------------

export interface SoftInactivePoint {
  capturedAt: string;
  period: string;
  softInactiveCount: number;
  eligibleDeviceCount: number;
  deficitMode: boolean;
}
export interface SoftInactiveZoneSeries {
  zoneId: string;
  zoneName: string;
  points: SoftInactivePoint[];
}
export interface SoftInactiveTrend extends DataAsOf {
  sinceDays: number;
  zones: SoftInactiveZoneSeries[];
}

export const apiSoftInactiveTrend = (params: { days?: number } = {}) => {
  const q = new URLSearchParams();
  if (params.days !== undefined) q.set('days', String(params.days));
  const qs = q.toString();
  return get<SoftInactiveTrend>(`/reports/soft-inactive-trend${qs ? `?${qs}` : ''}`);
};

// ---- Work-type mix + Verification outcomes (Issue 90) ---------------------------

export type WorkTypeKey = 'TROUBLESHOOT' | 'INSTALL' | 'RECOVERY';
export type VerifyOutcomeKey = 'CLOSED' | 'CLOSED_AUTO_RECOVERY' | 'PARTIAL_RECOVERY' | 'FAILED_VERIFICATION' | 'FAILED_ACTIVATION' | 'PENDING';

export interface WorkTypeMixReport extends DataAsOf {
  from: string;
  to: string;
  total: number;
  filters: { zoneId: number | null; companyId: number | null; plantId: number | null };
  rows: { workType: WorkTypeKey; count: number; pct: number }[];
}

export interface VerificationOutcomesReport extends DataAsOf {
  from: string;
  to: string;
  total: number;
  fraudFlagged: number;
  filters: { zoneId: number | null; companyId: number | null; plantId: number | null };
  rows: { outcome: VerifyOutcomeKey; count: number; pct: number }[];
}

/** Both endpoints default to the trailing 30-day window when `from`/`to` are omitted. */
export const apiWorkTypeMix = () => get<WorkTypeMixReport>('/reports/work-type-mix');
export const apiVerificationOutcomes = () => get<VerificationOutcomesReport>('/reports/verification-outcomes');

// ---- Root Cause Analytics (Issue 41, FE-23) ------------------------------------

export interface RootCauseSlice {
  category: string;
  count: number;
  pct: number; // share of total submissions, 0–100
}
export interface RootCauseReport extends DataAsOf {
  fromMonth: string;
  toMonth: string;
  totalSubmissions: number;
  filters: { zoneId: number | null; companyId: number | null; plantId: number | null; deviceType: string | null; seId: string | null };
  distribution: RootCauseSlice[];
}
export const apiRootCause = () => get<RootCauseReport>('/reports/root-cause');

// ---- System Efficiency (Issue 42, FE-24) ---------------------------------------

export interface EfficiencyMetrics {
  failureCyclesOpened: number;
  ticketsCreated: number;
  troubleshootTicketsCreated: number;
  autoAssignments: number;
  manualAssignments: number;
  overrides: number;
  autoAssignmentRatePct: number;
  manualAssignmentRatePct: number;
  overrideRatePct: number;
  cyclesResolved: number;
  verifiedCycles: number;
  failedVerifications: number;
  autoRecoveries: number;
  repeatFailures: number;
  firstTimeFixes: number;
  componentPauses: number;
  agedResolutions: number;
  autoEscalations: number;
  repeatFailureRatePct: number;
  firstTimeFixRatePct: number;
  failedVerificationRatePct: number;
  autoRecoveryRatePct: number;
}
export interface SystemEfficiencyReport extends DataAsOf {
  from: string;
  to: string;
  filters: { zoneId: number | null; companyId: number | null; plantId: number | null; deviceType: string | null; seId: string | null };
  fleet: EfficiencyMetrics;
  byZone: (EfficiencyMetrics & { zoneId: string | null; zoneName: string | null })[];
}
export const apiSystemEfficiency = () => get<SystemEfficiencyReport>('/reports/efficiency');

// ---- ZM Performance Scorecard (Issue 43, FE-25, Operations-Head only) -----------

export interface ZmScorecardRow {
  zmId: string;
  zmName: string;
  zoneId: number;
  zoneName: string;
  overrides: number;
  removals: number;
  deferrals: number;
  reorders: number;
  swaps: number;
  reassignments: number;
  splitBatches: number;
  overrideAfterOnsite: number;
  manualAssignments: number;
  autoAssigned: number;
  overrideRatePct: number;
  /** Zone Fleet-Uptime compliance — `null` when the zone had no eligible device-time (#346). */
  zoneSlaCompliancePct: number | null;
}
export interface ZmScorecardReport extends DataAsOf {
  fromMonth: string;
  toMonth: string;
  zoneId: number | null;
  rows: ZmScorecardRow[];
  trend: unknown[];
}
export const apiZmScorecard = () => get<ZmScorecardReport>('/reports/zm-scorecard');

// ---- Commissioning cohort & install quality (#232 / #233 / #234) ----------------

/**
 * Which fitments are in the measure (#233). `operational` — the default, and the same population
 * every rate on the dashboard is taken over — excludes warehouse devices and deactivated plants.
 * `all` reproduces the pre-#233 figures and exists for reconciliation, not as a second measure.
 */
export type CommissioningPopulation = 'operational' | 'all';

/** Every fitment in the window and where each one went. The four parts sum to `fitmentsInWindow`. */
export interface CommissioningPopulationCensus {
  fitmentsInWindow: number;
  operational: number;
  warehouse: number;
  deactivatedPlant: number;
  unmirrored: number;
}

export interface CommissioningTiming {
  /** Null — rendered "—" — when nothing was measured. Never conflate with a measured 0. */
  medianHours: number | null;
  p95Hours: number | null;
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

export interface CommissioningResolutionBucket {
  upToHours: number;
  fitments: number;
  cumulativeOnline: number;
  /** Null when the curve has no denominator — the chart must draw nothing, not a line at 0. */
  cumulativeOnlinePct: number | null;
}

/** How fast the cohort came online (#234). See `preEpochExcluded` for the one counter-intuitive part. */
export interface CommissioningResolution {
  maturityHours: number;
  maturedFitments: number;
  curveFitments: number;
  sampleSize: number;
  neverOnline: number;
  /** Matured but fitted before the TTFR epoch — excluded whatever they did, so the gate is symmetric. */
  preEpochExcluded: number;
  buckets: CommissioningResolutionBucket[];
  beyondLastBucket: number;
}

export type InstallerKind = 'PERSON' | 'SERVICE_ACCOUNT' | 'UNCLASSIFIED' | 'UNATTRIBUTED';

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
  /** Non-null only when the viewer is CLAMPED (a ZM) — the page renders its caveat off this. */
  scopedToZoneId: string | null;
  filters: { zoneId: string | null; plantId: string | null; remarks: string[] | null; population: CommissioningPopulation };
  population: CommissioningPopulationCensus;
  resolution: CommissioningResolution;
  totals: CohortCounts;
  byPlant: CohortPlantRow[];
  byInstaller: CohortInstallerRow[];
}

export interface InstallQualityRow {
  installerKey?: string | null;
  installerKind?: InstallerKind;
  plantId?: string;
  plantName?: string;
  zoneId?: string;
  installs: number;
  neverOnline: number;
  /** 0–1, three decimals. */
  neverOnlineRate: number;
  firstInstallAt: string | null;
  lastInstallAt: string | null;
  distinctPlants: number;
  /** 1 across many installs is the one-afternoon signature. */
  distinctInstallDays: number;
  ttfr: CommissioningTiming;
}

export interface InstallQualityReport {
  lookbackDays: number;
  since: string;
  generatedAt: string;
  groupBy: 'installer' | 'plant';
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

/**
 * The live cohort. `cohortDays` is capped at 90 server-side — a measured performance contract, not
 * taste — so the page says "last 90 days" rather than "last 3 months".
 */
export const apiCommissioningCohort = (params: {
  cohortDays?: number;
  graceHours?: number;
  population?: CommissioningPopulation;
  remarks?: string[];
} = {}) => {
  const q = new URLSearchParams();
  if (params.cohortDays !== undefined) q.set('cohortDays', String(params.cohortDays));
  if (params.graceHours !== undefined) q.set('graceHours', String(params.graceHours));
  if (params.population !== undefined) q.set('population', params.population);
  // Repeatable: Express hands the backend a string for one and an array for several.
  for (const remark of params.remarks ?? []) q.append('remark', remark);
  const qs = q.toString();
  return get<CommissioningCohortReport>(`/reports/commissioning/cohort${qs ? `?${qs}` : ''}`);
};

/** Install quality over a longer lookback — the historical installer / plant breakdown. */
export const apiCommissioningInstallers = (params: {
  lookbackDays?: number;
  groupBy?: 'installer' | 'plant';
  sort?: 'installs' | 'neverOnlineRate';
  minInstalls?: number;
  population?: CommissioningPopulation;
} = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const qs = q.toString();
  return get<InstallQualityReport>(`/reports/commissioning/installers${qs ? `?${qs}` : ''}`);
};
