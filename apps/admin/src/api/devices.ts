// Typed client for the Device Detail surface (FE-22) over the Issue 44/49 device reads + the new
// Issue-list endpoint. Manager-scoped server-side; token from the shared sessionStorage key.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

function authHeaders(json = false): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) };
}
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as T;
}

export interface DeviceListRow {
  deviceId: string;
  vehicleNo: string | null;
  deviceType: string | null;
  dealType: 'RECURRING' | 'ONE_TIME' | null;
  plantName: string | null;
  zoneName: string | null;
  companyName: string | null;
  slaBucket: string | null;
  /** Device's last GPS ping (Issue 3) — the UI derives the elapsed inactive duration. Null if never seen. */
  latestGpsDatetime: string | null;
  isInactive: boolean;
  /** The device's latest live ticket, if any — the assignment context (Issue 122). */
  openTicketId?: string | null;
  openTicketStatus?: string | null;
  /** UNASSIGNED | FORMALLY_ASSIGNED for the open ticket; null when the device has no live ticket. */
  assignmentState?: string | null;
  assignedSeName?: string | null;
  batchId?: string | null;
  batchStatus?: string | null;
  scheduleId?: string | null;
}

export interface DeviceCycle {
  cycleId: string;
  openedAt: string;
  closedAt: string | null;
  durationSeconds: number;
  slaBucketReached: string | null;
  repeatFailure: boolean;
  assignedSeId: string | null;
  rootCauseCategory: string | null;
  componentRelated: boolean;
  vehicleUnavailableImpact: boolean;
  componentBlockedImpact: boolean;
  verificationOutcome: string | null;
  closureType: string | null;
  autoRecovery: boolean;
}

export interface DowntimeTrendMonth {
  month: string;
  downtimeHours: number;
  cycleCount: number;
  repeatFailureCount: number;
  autoRecoveryClosures: number;
  seRepairedClosures: number;
  componentDowntimeHours: number;
  avgTimeToRecoverHours: number | null;
}
export interface DeviceDowntimeTrend {
  deviceId: string;
  lifetime: {
    totalCycles: number;
    totalDowntimeHours: number;
    repeatFailures: number;
    longestEpisodeHours: number;
    avgTimeToRecoverHours: number | null;
    autoRecoveryClosures: number;
    seRepairedClosures: number;
  };
  monthly: DowntimeTrendMonth[];
  rootCauseTrend: { month: string; category: string; count: number }[];
}

export interface DeviceView {
  deviceId: string;
  dealType: 'RECURRING' | 'ONE_TIME' | null;
  currentVehicleId: string | null;
  deviceType: string | null;
  simId: string | null;
}

/** One page of the Device Detail list — the rows for the requested window + the full filtered total. */
export interface DeviceListPage {
  rows: DeviceListRow[];
  total: number;
}

export type DeviceSort = 'LONGEST_INACTIVE' | 'NEWEST_ACTIVITY' | 'SLA_SEVERITY' | 'DEVICE_ID' | 'PRIORITY';
export type DeviceStatusFilter = 'ALL' | 'INACTIVE' | 'ACTIVE';

export interface DeviceListParams {
  search?: string;
  limit?: number;
  offset?: number;
  sort?: DeviceSort;
  status?: DeviceStatusFilter;
  bucket?: string;
  /** Numeric zone id, or the literal `'UNZONED'`. */
  zoneId?: number | 'UNZONED';
  companyId?: number;
  plantId?: number;
  /** Restrict to devices at or above CRITICAL severity (scorecard drill-down). */
  criticalPlus?: boolean;
}

/** The distinct zones / companies / plants in the caller's scope — sources the filter dropdowns. */
export interface DeviceFilterOptions {
  zones: { zoneId: number; name: string }[];
  companies: { companyId: number; name: string }[];
  /** Plant × company pairs, so the plant dropdown can follow the company pick (Issue 122b). */
  plants?: { plantId: number; name: string; companyId: number }[];
  hasUnzoned: boolean;
}

/** Paged, sorted, filtered device list. `limit`/`offset` drive the pager; `total` is the full filtered count. */
export async function apiDeviceList(opts: DeviceListParams = {}): Promise<DeviceListPage> {
  const params = new URLSearchParams();
  const search = opts.search?.trim();
  if (search) params.set('search', search);
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.status && opts.status !== 'ALL') params.set('status', opts.status);
  if (opts.bucket) params.set('bucket', opts.bucket);
  if (opts.zoneId != null) params.set('zoneId', String(opts.zoneId));
  if (opts.companyId != null) params.set('companyId', String(opts.companyId));
  if (opts.plantId != null) params.set('plantId', String(opts.plantId));
  if (opts.criticalPlus) params.set('criticalPlus', 'true');
  const qs = params.toString();
  const data = await get<DeviceListPage | DeviceListRow[]>(`/devices${qs ? `?${qs}` : ''}`);
  // Tolerate both shapes: the paged `{ rows, total }` and the legacy bare array (a backend that
  // predates pagination, or one not yet restarted) — so a shape mismatch never blanks the page.
  if (Array.isArray(data)) return { rows: data, total: data.length };
  return { rows: data.rows ?? [], total: data.total ?? 0 };
}

/** Distinct zones + companies present in the caller's scope, for the filter dropdowns. */
export const apiDeviceFilterOptions = () => get<DeviceFilterOptions>('/devices/filter-options');
export const apiDeviceCycles = (id: string) => get<{ deviceId: string; cycles: DeviceCycle[] }>(`/devices/${encodeURIComponent(id)}/cycles`);
export const apiDeviceDowntimeTrend = (id: string) => get<DeviceDowntimeTrend>(`/devices/${encodeURIComponent(id)}/downtime-trend`);

/** Operations-Head manual deal-type tag (Issue 49; closes the deferred #49 tag UI). */
export async function apiSetDealType(id: string, dealType: 'RECURRING' | 'ONE_TIME'): Promise<DeviceView> {
  const res = await fetch(`${BASE_URL}/devices/${encodeURIComponent(id)}/deal-type`, {
    method: 'PATCH',
    headers: authHeaders(true),
    body: JSON.stringify({ dealType }),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as DeviceView;
}
