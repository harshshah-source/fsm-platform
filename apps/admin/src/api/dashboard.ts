// Typed client for the Zone Operations Dashboard endpoints (Issue 06). Mirrors the backend
// DashboardService view types; token comes from the same sessionStorage key AuthProvider writes.

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

export interface ZoneOverviewRow {
  zoneId: string;
  zoneName: string;
  /** The zone's Zonal Manager display name (Issue 122 scorecard column); null when unset. */
  zonalManagerName?: string | null;
  totalInactive: number;
  /** All devices (active + inactive) in the zone — denominator for `inactive / total` (Issue 2). */
  totalDevices: number;
  byBucket: Record<string, number>;
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
  /** All devices (active + inactive) at this plant — denominator for `inactive / total` (Issue 2). */
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
  clusterSize: number;
  suggestedSes: unknown[];
  tickets: CriticalQueueTicket[];
}

export interface ActionRequiredCard {
  key: string;
  label: string;
  urgency: number;
  count: number;
  available: boolean;
  source: string;
}

/** Headline fleet counts for the KPI strip (Issue 122b): companies / plants / devices in scope. */
export interface FleetSummary {
  companies: number;
  plants: number;
  devices: number;
}

/** One company / plant row in the Fleet Directory (the Companies/Plants KPI click-through). */
export interface FleetDirectoryCompany {
  companyId: string;
  name: string;
  tier: string | null;
  plantCount: number;
  deviceCount: number;
}
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

export const apiZoneOverview = () => get<ZoneOverviewRow[]>('/dashboard/zone-overview');

export const apiFleetSummary = () => get<FleetSummary>('/dashboard/fleet-summary');

export const apiFleetDirectory = () => get<FleetDirectory>('/dashboard/fleet-directory');

export const apiCompanyPlantOverview = (params: { companyId?: string; plantId?: string } = {}) => {
  const q = new URLSearchParams();
  if (params.companyId) q.set('companyId', params.companyId);
  if (params.plantId) q.set('plantId', params.plantId);
  const qs = q.toString();
  return get<CompanyPlantRow[]>(`/dashboard/company-plant-overview${qs ? `?${qs}` : ''}`);
};

export const apiCriticalQueue = () => get<CriticalQueueGroup[]>('/dashboard/critical-queue');

export const apiActionRequired = () => get<ActionRequiredCard[]>('/dashboard/action-required');

// ---- Fleet-activity trend (Issue 134) ------------------------------------------

export type ActivityTrendRange = '1D' | '7D' | '1M' | '1Y' | 'MAX';
export type ActivityTrendBucket = 'hour' | 'day' | 'month';

export interface ActivityTrendPoint {
  /** UTC-truncated bucket start, `YYYY-MM-DD HH:MM:SS`. */
  bucket: string;
  /** Inactive-device stock; null when no snapshot exists for the bucket (sparse history). */
  inactive: number | null;
  troubleshoot: number;
  installation: number;
}

export interface ActivityTrendReport {
  range: ActivityTrendRange;
  from: string;
  to: string;
  bucket: ActivityTrendBucket;
  /** Resolved scope: the ZM's zone, an OH/CSM's chosen zone, or null for pan-India. */
  zoneId: number | null;
  points: ActivityTrendPoint[];
}

/** Inactive-device stock vs Troubleshoot vs Installation over time. Omit `zoneId` for pan-India;
 *  a ZM is clamped to their own zone server-side regardless of what is passed. */
export const apiActivityTrend = (params: { range: ActivityTrendRange; zoneId?: string | number }) => {
  const q = new URLSearchParams();
  q.set('range', params.range);
  if (params.zoneId !== undefined && params.zoneId !== '') q.set('zoneId', String(params.zoneId));
  return get<ActivityTrendReport>(`/dashboard/activity-trend?${q.toString()}`);
};
