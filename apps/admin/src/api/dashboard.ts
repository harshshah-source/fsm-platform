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

/**
 * The device counts for one entity, over a SINGLE operational population (mirrors the backend
 * `FleetCounts`). Every `inactive / total` on the dashboard reads `inactiveOperational /
 * operationalDevices` — never `mirroredDevices`, which includes warehouse stock and so silently
 * understated every inactivity rate before 2026-07-29.
 */
export interface FleetCounts {
  /** Operational + warehouse. What FSM mirrors for this entity — NOT the AutoPlant catalog. */
  mirroredDevices: number;
  /** Deployed and tracked (`is_departed = false`) — the denominator for every rate. */
  operationalDevices: number;
  /** Removed from field operations. Reconciles separately; never in a rate. */
  warehouseDevices: number;
  /** Operational devices currently inactive. Equals the sum of the per-SLA-bucket columns. */
  inactiveOperational: number;
  /** `healthyOperational + inactiveOperational === operationalDevices`, at every level. */
  healthyOperational: number;
  /** Percentage of the OPERATIONAL fleet; null when the entity has no operational devices. */
  inactivePct: number | null;
  fleetHealthPct: number | null;
}

export interface ZoneOverviewRow extends FleetCounts {
  zoneId: string;
  zoneName: string;
  /** The zone's Zonal Manager display name (Issue 122 scorecard column); null when unset. */
  zonalManagerName?: string | null;
  byBucket: Record<string, number>;
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

/** Headline fleet counts for the KPI strip: companies / plants / the operational breakdown in scope. */
export interface FleetSummary extends FleetCounts {
  companies: number;
  plants: number;
  /**
   * SOURCE metric: the raw AutoPlant device-catalog total from the last successful master sync,
   * pan-India, all deployment statuses. Rendered as "AutoPlant Catalog" — never compared against the
   * operational counts, which come from a different system as of a different moment.
   */
  catalogDevices: number | null;
  /** ISO timestamp of the master sync that produced `catalogDevices`. */
  lastMasterSyncAt: string | null;
  /** ISO timestamp of the latest successful telemetry snapshot — how fresh the inactivity ages are. */
  lastSnapshotAt: string | null;
}

/** One company / plant row in the Fleet Directory (the Companies/Plants KPI click-through). */
export interface FleetDirectoryCompany extends FleetCounts {
  companyId: string;
  name: string;
  tier: string | null;
  plantCount: number;
  lastSnapshotAt: string | null;
  lastActivityAt: string | null;
}
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

export const apiZoneOverview = () => get<ZoneOverviewRow[]>('/dashboard/zone-overview');

export const apiFleetSummary = () => get<FleetSummary>('/dashboard/fleet-summary');

export const apiFleetDirectory = () => get<FleetDirectory>('/dashboard/fleet-directory');

export const apiCompanyPlantOverview = (
  params: { companyId?: string; plantId?: string; zoneId?: string } = {},
) => {
  const q = new URLSearchParams();
  if (params.companyId) q.set('companyId', params.companyId);
  if (params.plantId) q.set('plantId', params.plantId);
  // Zone drill-down. A ZM is clamped server-side regardless of what is passed, so this narrows an
  // OH/CSM without widening anyone.
  if (params.zoneId) q.set('zoneId', params.zoneId);
  const qs = q.toString();
  return get<CompanyPlantRow[]>(`/dashboard/company-plant-overview${qs ? `?${qs}` : ''}`);
};

/** How a zone's currently-open work is held — the zone drill-down's assignment band. */
export interface ZoneOperationsSummary {
  openTickets: number;
  assigned: number;
  unassigned: number;
  liveBatches: number;
  overriddenBatches: number;
  engineersEngaged: number;
}

/**
 * Assignment + batch aggregate for one zone, scoped by the drill-down's own `status` filter
 * (`INACTIVE` = open work on still-silent devices, `ACTIVE` = open work on recovered ones, `ALL` =
 * both). A ZM is clamped to their own zone server-side.
 */
export const apiZoneOperations = (params: { zoneId?: string; status?: string } = {}) => {
  const q = new URLSearchParams();
  if (params.zoneId) q.set('zoneId', params.zoneId);
  if (params.status) q.set('status', params.status);
  const qs = q.toString();
  return get<ZoneOperationsSummary>(`/dashboard/zone-operations${qs ? `?${qs}` : ''}`);
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
