// Typed client for the SE Management surface (Issue 25, `/api/engineers`). Zone-scoped SE list +
// detail (manager roles) and the Set-Availability write (ZM / CSM / SE — never Operations Head).

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type ActivityStatus =
  | 'AVAILABLE'
  | 'ON_SITE'
  | 'BUSY'
  | 'SHIFT_ENDING'
  | 'OFFLINE'
  | 'ON_LEAVE'
  | 'OFF_SHIFT'
  | 'WEEKLY_OFF'
  | 'SOFT_UNAVAILABLE';

export type SettableStatus = 'ON_LEAVE' | 'OFF_SHIFT' | 'WEEKLY_OFF' | 'SOFT_UNAVAILABLE';

export interface KitMissing {
  componentId: string;
  name: string;
  shortBy: number;
}

export interface EngineerListRow {
  seId: string;
  name: string;
  zoneId: string;
  coverageType: string;
  activityStatus: ActivityStatus;
  availabilityStatus: string;
  activeTicketCount: number;
  kitComplete: boolean;
  missingKit: KitMissing[];
  dailyCapacity: number;
  isActive: boolean;
}

export interface VanStockItem {
  componentId: string;
  name: string;
  qty: number;
}

export interface AvailabilityRow {
  status: string;
  windowStart: string;
  windowEnd: string | null;
  reason: string | null;
  setByRole: string | null;
}

export interface EngineerDetail {
  seId: string;
  name: string;
  zoneId: string;
  coverageType: string;
  dailyCapacity: number;
  isActive: boolean;
  activityStatus: ActivityStatus;
  availabilityStatus: string;
  dayPlan: { status: string | null; ticketCount: number };
  vanStock: VanStockItem[];
  kit: { complete: boolean; missing: KitMissing[] };
  availabilityRows: AvailabilityRow[];
}

export interface SetAvailabilityBody {
  status: SettableStatus;
  windowStart: string;
  windowEnd?: string | null;
  reason?: string | null;
}

export async function apiEngineers(): Promise<EngineerListRow[]> {
  const res = await fetch(`${BASE_URL}/engineers`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as EngineerListRow[];
}

export async function apiEngineerDetail(seId: string): Promise<EngineerDetail> {
  const res = await fetch(`${BASE_URL}/engineers/${seId}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as EngineerDetail;
}

export async function apiSetAvailability(seId: string, body: SetAvailabilityBody): Promise<void> {
  const res = await fetch(`${BASE_URL}/engineers/${seId}/availability`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
}
