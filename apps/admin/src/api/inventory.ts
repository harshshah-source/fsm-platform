// Typed client for the Component-Blocked Queue (Issue 21) — the ZM read-only view of tickets the
// Recommender dropped for an incomplete Common Kit. Zone scope is enforced server-side.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface MissingComponent {
  componentId: string;
  name: string;
  shortBy: number;
}

export interface ComponentBlockedRow {
  id: string;
  ticketId: string;
  seId: string;
  companyName: string;
  zoneName: string;
  reason: string;
  missingComponents: MissingComponent[];
  wmActionStatus: string;
  blockedAt: string;
  ageDays: number;
  warehouseOverdue: boolean;
}

export async function apiComponentBlocked(): Promise<ComponentBlockedRow[]> {
  const res = await fetch(`${BASE_URL}/component-blocked`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as ComponentBlockedRow[];
}

// ---- Zone-warehouse stock (Issue 73) -------------------------------------------

export interface WarehouseStockRow {
  zoneId: string;
  zoneName: string;
  componentId: string;
  componentName: string;
  onHand: number;
  reserved: number;
  available: number;
  lowStockThreshold: number;
  lowStock: boolean;
}

export interface FulfillmentSla {
  totalReceived: number;
  withinSlaPct: number;
  avgFulfillmentHours: number | null;
  openRequests: number;
  slaWindowDays: number;
}

export async function apiWarehouseStock(): Promise<WarehouseStockRow[]> {
  const res = await fetch(`${BASE_URL}/inventory/warehouse-stock`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as WarehouseStockRow[];
}

export async function apiFulfillmentSla(): Promise<FulfillmentSla> {
  const res = await fetch(`${BASE_URL}/inventory/warehouse-stock/fulfillment-sla`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as FulfillmentSla;
}

export async function apiSetWarehouseStock(body: {
  zoneId: string | number;
  componentId: string | number;
  onHand?: number;
  reserved?: number;
  lowStockThreshold?: number;
}): Promise<WarehouseStockRow> {
  const res = await fetch(`${BASE_URL}/inventory/warehouse-stock`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as WarehouseStockRow;
}
