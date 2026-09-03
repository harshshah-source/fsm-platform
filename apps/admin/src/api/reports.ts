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

// ---- Report filters (#364) ------------------------------------------------------

/**
 * The dimensions the five filterable report endpoints accept. Not every endpoint takes every one —
 * see the `REPORT_FILTER_FIELDS` table below — so each `api*` function names its own subset rather
 * than forwarding whatever it is handed. A parameter an endpoint does not read is not harmless: it
 * silently produces the unfiltered number under a filtered-looking control.
 *
 * #364. Before this, every one of these calls went out bare. The backend has accepted
 * from/to/zone/company/plant/deviceType/SE since Issues 41–43 and 90 and the clients asked for none
 * of it, so a manager who wanted last month, or one zone, or one device type had no way to say so:
 * they read around the default window, or exported and filtered in Excel.
 *
 * **`from`/`to` are not one format.** `/reports/root-cause` and `/reports/zm-scorecard` read months
 * (`YYYY-MM`, `parseMonth`) and `/reports/efficiency`, `/reports/work-type-mix` and
 * `/reports/verification-outcomes` read days (`YYYY-MM-DD`, `parseDay`); the wrong granularity is a
 * 400, not a coerced value. The granularity therefore belongs to the *page*, which is why
 * {@link ReportRangeGranularity} is threaded through the filter bar rather than guessed here.
 */
export interface ReportFilterParams {
  /** `YYYY-MM` for the month-ranged reports, `YYYY-MM-DD` for the day-ranged ones. */
  from?: string | null;
  to?: string | null;
  zoneId?: number | string | null;
  companyId?: number | string | null;
  plantId?: number | string | null;
  deviceType?: string | null;
  seId?: string | null;
}

export type ReportRangeGranularity = 'day' | 'month';

export type ReportFilterField = keyof ReportFilterParams;

/**
 * Which dimensions each endpoint actually reads, taken from `reports.controller.ts`. Keeping it as
 * data rather than five hand-written query builders is what stops a filter being *offered* on a page
 * whose endpoint ignores it — the filter bar renders its controls from the same table.
 */
export const REPORT_FILTER_FIELDS = {
  rootCause: ['from', 'to', 'zoneId', 'companyId', 'plantId', 'deviceType', 'seId'],
  efficiency: ['from', 'to', 'zoneId', 'companyId', 'plantId', 'deviceType', 'seId'],
  /** Operations-Head only, and zone is a drill-down rather than a clamp — no company/plant/SE dims. */
  zmScorecard: ['from', 'to', 'zoneId'],
  distribution: ['from', 'to', 'zoneId', 'companyId', 'plantId'],
} as const satisfies Record<string, readonly ReportFilterField[]>;

/**
 * Serialise the subset of `params` an endpoint reads. Empty string, `null` and `undefined` all mean
 * "not filtered" and are dropped, so an untouched filter bar produces the bare URL it always did and
 * every endpoint keeps its own documented default window.
 */
export function reportQuery(params: ReportFilterParams, fields: readonly ReportFilterField[]): string {
  const q = new URLSearchParams();
  for (const field of fields) {
    const value = params[field];
    if (value === undefined || value === null || value === '') continue;
    q.set(field, String(value));
  }
  const qs = q.toString();
  return qs ? `?${qs}` : '';
}

/** The first and last day of `YYYY-MM`, for a page whose month picker feeds a day-ranged endpoint. */
export function monthDayRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** `YYYY-MM` of `now` (UTC) — the month every month-ranged report defaults to server-side. */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

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

/**
 * Both endpoints default to the trailing 30-day window when `from`/`to` are omitted, and both read
 * DAYS. They take zone/company/plant only — no device type, no SE — because they aggregate `tickets`
 * and `verification_runs` directly rather than a cube carrying those dimensions.
 */
export const apiWorkTypeMix = (params: ReportFilterParams = {}) =>
  get<WorkTypeMixReport>(`/reports/work-type-mix${reportQuery(params, REPORT_FILTER_FIELDS.distribution)}`);
export const apiVerificationOutcomes = (params: ReportFilterParams = {}) =>
  get<VerificationOutcomesReport>(`/reports/verification-outcomes${reportQuery(params, REPORT_FILTER_FIELDS.distribution)}`);

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
/** `from`/`to` are MONTHS (`YYYY-MM`); this endpoint reads `root_cause_summary_monthly`. */
export const apiRootCause = (params: ReportFilterParams = {}) =>
  get<RootCauseReport>(`/reports/root-cause${reportQuery(params, REPORT_FILTER_FIELDS.rootCause)}`);

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
/** `from`/`to` are DAYS (`YYYY-MM-DD`); this endpoint reads `system_efficiency_summary_daily`. */
export const apiSystemEfficiency = (params: ReportFilterParams = {}) =>
  get<SystemEfficiencyReport>(`/reports/efficiency${reportQuery(params, REPORT_FILTER_FIELDS.efficiency)}`);

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
/**
 * One month of one ZM's decision activity. Mirrors `ZmScorecardTrendPoint` in `reports.service.ts`.
 *
 * #364 — the backend has computed this since Issue 43 (`reports.service.ts:540`) and the client typed
 * the whole array `unknown[]`, which is how a computed series stayed undrawn for four months: nothing
 * could consume it without an assertion, so nothing did. The scorecard ranks *people*; a rank without
 * a direction of travel cannot distinguish a ZM whose override rate is high and falling from one
 * whose is high and climbing, and only one of those is a problem.
 */
export interface ZmScorecardTrendPoint {
  /** The month's first day, ISO (`2026-06-01`) — the cube's `month` column, not a `YYYY-MM`. */
  month: string;
  overrides: number;
  overrideAfterOnsite: number;
  manualAssignments: number;
  overrideRatePct: number;
  /** `null` for a month with no eligible device-time — a GAP on the trend, never a plotted 100 (#346). */
  zoneSlaCompliancePct: number | null;
}
export interface ZmScorecardSeries {
  zmId: string;
  zmName: string;
  points: ZmScorecardTrendPoint[];
}
export interface ZmScorecardReport extends DataAsOf {
  fromMonth: string;
  toMonth: string;
  zoneId: number | null;
  rows: ZmScorecardRow[];
  trend: ZmScorecardSeries[];
}
/** `from`/`to` are MONTHS (`YYYY-MM`). `zoneId` is a drill-down, not a clamp — this report is OH-only. */
export const apiZmScorecard = (params: ReportFilterParams = {}) =>
  get<ZmScorecardReport>(`/reports/zm-scorecard${reportQuery(params, REPORT_FILTER_FIELDS.zmScorecard)}`);

// ---- SE Productivity (#365) -----------------------------------------------------

export type SeProductivityGranularity = 'weekly' | 'monthly';
export type SeCoverageFilter = 'all' | 'DEDICATED' | 'MULTI_PLANT' | 'FLOATING';

/** How each coverage type reads on the page. The design's Coverage column says "Dedicated"/"Floating". */
export const SE_COVERAGE_LABEL: Record<string, string> = {
  DEDICATED: 'Dedicated',
  MULTI_PLANT: 'Multi-plant',
  FLOATING: 'Floating',
};

/**
 * One engineer's row.
 *
 * **Every rate is `number | null` and the null is load-bearing.** It means one of two things, and
 * `ratesSuppressed` is what separates them: below {@link SeProductivityReport.rateMinSample} closures
 * the server withholds the rate deliberately (an operator constraint on the approved design — a
 * six-closure engineer has no meaningful first-time-fix percentage, and drawing one invites acting on
 * noise), or the metric simply has no denominator in the window. Both render as an em dash; neither
 * may ever be formatted as `0%`, which reads as a measured failure.
 *
 * `repairClosures` and `departureClosures` are separate for audit finding **F7**: a
 * `DEVICE_UNDEPLOYED_CLOSE` is a vehicle leaving the fleet, not work anybody did, and summed into the
 * repair count it made the engineer with the unluckiest plants read as the most productive one.
 */
export interface SeProductivityRow {
  seId: string;
  name: string;
  coverageType: 'DEDICATED' | 'MULTI_PLANT' | 'FLOATING';
  zoneId: string;
  zoneName: string | null;
  closures: number;
  repairClosures: number;
  departureClosures: number;
  firstTimeFixes: number;
  firstTimeFixRatePct: number | null;
  verificationsDecided: number;
  failedVerifications: number;
  failedVerificationRatePct: number | null;
  onsiteToSubmissionCount: number;
  avgOnsiteToSubmissionSeconds: number | null;
  ratesSuppressed: boolean;
}

export interface SeProductivityReport extends DataAsOf {
  granularity: SeProductivityGranularity;
  from: string;
  to: string;
  /** The closure count below which the server withholds rates. Rendered in the footer, never guessed. */
  rateMinSample: number;
  /** `zoneId` is the CLAMPED zone — what the scope chip must render, never the local pick. */
  filters: { zoneId: number | null; coverage: SeCoverageFilter };
  totals: { engineers: number; closures: number; repairClosures: number; departureClosures: number };
  rows: SeProductivityRow[];
}

/**
 * `/reports/se-productivity`. Monthly takes `month` (`YYYY-MM`); weekly takes `weekOf` (any
 * `YYYY-MM-DD` in the wanted week — the server resolves it to that week's Monday). The zone parameter
 * is a convenience for CSM / OH: a ZM is clamped server-side whatever is sent.
 */
export const apiSeProductivity = (params: {
  granularity?: SeProductivityGranularity;
  month?: string | null;
  weekOf?: string | null;
  zoneId?: number | string | null;
  coverage?: SeCoverageFilter | null;
} = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || (k === 'coverage' && v === 'all')) continue;
    q.set(k, String(v));
  }
  const qs = q.toString();
  return get<SeProductivityReport>(`/reports/se-productivity${qs ? `?${qs}` : ''}`);
};

/**
 * **The out-of-band bands** — fixed operational thresholds, not percentiles of the visible cohort.
 *
 * The design forbids ranking, so a "worst two rows" rule is exactly what must not be built: it would
 * always flag somebody, including in a zone where everyone is fine, and it would move a person's
 * marking when a colleague's month changed. A fixed band flags a *number* against what the operation
 * expects of it, which is what makes the mark answerable — "why is this one 57%?" has an answer;
 * "why is this one in the bottom two?" does not.
 */
export const SE_PRODUCTIVITY_BANDS = {
  /** Higher is better — amber below `warn`, crimson below `bad`. */
  firstTimeFixPct: { warn: 65, bad: 50 },
  /** Lower is better. */
  failedVerificationPct: { warn: 8, bad: 12 },
  /** Lower is better; seconds. 1h 40m / 3h. */
  onsiteToSubmissionSeconds: { warn: 6_000, bad: 10_800 },
} as const;

export type SeMetricTone = 'normal' | 'warn' | 'bad';

/** Where one value sits in its band. `null` (withheld or no sample) is never marked. */
export function seMetricTone(
  value: number | null,
  band: { warn: number; bad: number },
  direction: 'higherIsBetter' | 'lowerIsBetter',
): SeMetricTone {
  if (value === null) return 'normal';
  if (direction === 'higherIsBetter') {
    if (value < band.bad) return 'bad';
    return value < band.warn ? 'warn' : 'normal';
  }
  if (value > band.bad) return 'bad';
  return value > band.warn ? 'warn' : 'normal';
}

/** `1h 12m` — the design's stage-time format. `null` is the em dash, never `0h 00m`. */
export function formatStageDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const total = Math.max(0, Math.round(seconds / 60));
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

/** A rate cell: the percentage, or an em dash when the server withheld it or had no sample. */
export function formatRate(pct: number | null): string {
  return pct === null ? '—' : `${pct}%`;
}

/** The Monday of the ISO week containing `day` (UTC), as `YYYY-MM-DD`. */
export function weekStart(day: string | Date = new Date()): string {
  const d = typeof day === 'string' ? new Date(`${day}T00:00:00Z`) : day;
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return new Date(utc.getTime() - ((utc.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}

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
