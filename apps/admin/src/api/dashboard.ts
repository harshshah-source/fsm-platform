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
  totalInactive: number;
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
  byBucket: Record<string, number>;
}

export interface CriticalQueueTicket {
  ticketId: string;
  deviceId: string;
  slaBucket: string;
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

export const apiZoneOverview = () => get<ZoneOverviewRow[]>('/dashboard/zone-overview');

export const apiCompanyPlantOverview = (params: { companyId?: string; plantId?: string } = {}) => {
  const q = new URLSearchParams();
  if (params.companyId) q.set('companyId', params.companyId);
  if (params.plantId) q.set('plantId', params.plantId);
  const qs = q.toString();
  return get<CompanyPlantRow[]>(`/dashboard/company-plant-overview${qs ? `?${qs}` : ''}`);
};

export const apiCriticalQueue = () => get<CriticalQueueGroup[]>('/dashboard/critical-queue');

export const apiActionRequired = () => get<ActionRequiredCard[]>('/dashboard/action-required');
