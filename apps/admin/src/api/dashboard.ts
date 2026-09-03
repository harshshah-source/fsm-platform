// Typed client for the Zone Operations Dashboard endpoints (Issue 06). Mirrors the backend
// DashboardService view types; token comes from the same sessionStorage key AuthProvider writes.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

// The shared `authHeaders()` (not a local bearer-only copy): it also carries `X-Acting-As-Zone`, so a
// CSM / Operations Head acting in a zone gets that zone's aggregations. Without it the dashboard
// swapped to the Zone Operations view but kept asking for — and showing — pan-India numbers.
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as T;
}

/**
 * The device counts for one entity, over a SINGLE operational population (mirrors the backend
 * `FleetCounts`). Every `inactive / total` on the dashboard reads `inactiveOperational /
 * reportingOperational` — never `mirroredDevices`, which includes warehouse stock and so silently
 * understated every inactivity rate before 2026-07-29, and (since #223) never `operationalDevices`,
 * which includes devices that have never reported at all.
 */
export interface FleetCounts {
  /** Operational + warehouse. What FSM mirrors for this entity — NOT the AutoPlant catalog. */
  mirroredDevices: number;
  /** Deployed and tracked (`is_departed = false`). `= healthy + inactive + neverReported`. */
  operationalDevices: number;
  /** Removed from field operations. Reconciles separately; never in a rate. */
  warehouseDevices: number;
  /** Operational devices that have reported at least once — the denominator for every rate (#223). */
  reportingOperational: number;
  /** Reporting devices currently inactive. Equals the sum of the per-SLA-bucket columns. */
  inactiveOperational: number;
  /** `healthyOperational + inactiveOperational === reportingOperational`, at every level. */
  healthyOperational: number;
  /**
   * Operational devices that have never sent a single GPS fix (#223) — the third fleet state.
   *
   * Before 2026-08-09 these were counted as `healthyOperational`, because healthy was defined as the
   * negation of inactive and a device with no timestamp can never be inactive. Shown beside Fleet
   * Health rather than inside it (operator decision P4): "never worked" is an installation failure
   * with a different owner from "stopped working".
   */
  neverReported: number;
  /** Percentage of the REPORTING fleet; null when the entity has nothing that has reported. */
  inactivePct: number | null;
  fleetHealthPct: number | null;
}

export interface ZoneOverviewRow extends FleetCounts {
  zoneId: string;
  zoneName: string;
  /** The zone's Zonal Manager display name (Issue 122 scorecard column); null when unset. */
  zonalManagerName?: string | null;
  byBucket: Record<string, number>;
  /**
   * #351 — signed % change in the zone's Soft Inactive Count between its two most recent
   * `soft_inactive_count_history` captures, 1dp. Null when the zone has fewer than two captures, or
   * when the earlier one was zero (no percentage exists from a zero baseline) — the two cases the
   * table must not render as "0%". Captures are twice daily, so the comparison is against the
   * previous *period*; the field name predates that cadence and is kept for wire stability.
   */
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
  /** How many CRITICAL+ tickets sit at this plant — one site visit's worth of work. */
  clusterSize: number;
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

/**
 * B5 — `zoneId` narrows a CSM/OH to one zone; a ZM is clamped server-side either way.
 *
 * The Scheduler Console **must** pass it. Rendered beside a single-zone deck, the unscoped counts are
 * a national number under a zone's heading, and the two panes disagree about how much trouble that
 * zone is in. The dashboard keeps calling it with no argument, which is correct there.
 */
export const apiActionRequired = (zoneId?: string) =>
  get<ActionRequiredCard[]>(
    `/dashboard/action-required${zoneId ? `?zoneId=${encodeURIComponent(zoneId)}` : ''}`,
  );

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
