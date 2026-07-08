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

export const apiDeviceList = (search?: string) =>
  get<DeviceListRow[]>(`/devices${search && search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''}`);
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
