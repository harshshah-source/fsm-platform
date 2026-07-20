// Typed client for the `/api/reports/*` read surface (Issues 39/40). Mirrors the backend
// ReportsService view types. Token comes from the same sessionStorage key AuthProvider writes.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

async function get<T>(path: string): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as T;
}

// ---- Fleet Uptime % (Issue 39) -------------------------------------------------

export type FleetUptimeGroupBy = 'zone' | 'company' | 'plant';

export interface FleetUptimeRow {
  id: string;
  name: string;
  eligibleDeviceCount: number;
  uptimePct: number;
  autoRecoveryClosures: number;
  seRepairedClosures: number;
}

export interface FleetUptimeReport {
  month: string;
  groupBy: FleetUptimeGroupBy;
  fleet: {
    eligibleDeviceCount: number;
    uptimePct: number;
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

/**
 * Fleet Uptime % monthly trend (Issue 39). The endpoint is single-month, so the trend is a fan-out of
 * the last `count` months; failures are dropped so a partially-seeded history still renders.
 */
export async function apiFleetUptimeTrend(count = 6, now: Date = new Date()): Promise<{ label: string; value: number }[]> {
  const months = recentMonths(count, now);
  const settled = await Promise.allSettled(months.map((m) => apiFleetUptime({ month: m, groupBy: 'zone' })));
  return settled.flatMap((r, i) =>
    r.status === 'fulfilled' ? [{ label: months[i].slice(2), value: r.value.fleet.uptimePct }] : [],
  );
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
export interface SoftInactiveTrend {
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

export interface WorkTypeMixReport {
  from: string;
  to: string;
  total: number;
  filters: { zoneId: number | null; companyId: number | null; plantId: number | null };
  rows: { workType: WorkTypeKey; count: number; pct: number }[];
}

export interface VerificationOutcomesReport {
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
export interface RootCauseReport {
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
export interface SystemEfficiencyReport {
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
  zoneSlaCompliancePct: number;
}
export interface ZmScorecardReport {
  fromMonth: string;
  toMonth: string;
  zoneId: number | null;
  rows: ZmScorecardRow[];
  trend: unknown[];
}
export const apiZmScorecard = () => get<ZmScorecardReport>('/reports/zm-scorecard');
