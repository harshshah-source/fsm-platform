// Typed client for the Warehouse Manager Shadow Use Queue (Issue 24). Unreconciled SHADOW_USE
// inventory rows + Mark Reconciled / Mark Disputed. WAREHOUSE_MANAGER only — enforced server-side.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface ShadowUseRow {
  id: string;
  ticketId: string | null;
  seId: string;
  componentId: string | null;
  componentName: string | null;
  qty: number;
  companyName: string | null;
  zoneName: string | null;
  status: string;
  reason: string | null;
  createdAt: string;
  ageDays: number;
}

export async function apiShadowUse(): Promise<ShadowUseRow[]> {
  const res = await fetch(`${BASE_URL}/warehouse/shadow-use`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as ShadowUseRow[];
}

async function post(path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${BASE_URL}/warehouse/shadow-use/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
}

export const apiReconcileShadowUse = (id: string) => post(`${id}/reconcile`);
export const apiDisputeShadowUse = (id: string, reason: string) => post(`${id}/dispute`, { reason });
