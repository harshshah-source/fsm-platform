import { authHeaders } from './authHeaders';
// Typed client for the Shadow Use Queue (Issue 24, #353). Unreconciled SHADOW_USE inventory rows +
// Mark Reconciled / Mark Disputed (WAREHOUSE_MANAGER only, enforced server-side), plus the disputes
// a Zonal Manager adjudicates — the read the server zone-clamps for a ZM.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

/** The statuses the list endpoint accepts. A WM may ask for any; every other role reads DISPUTED. */
export type ShadowUseStatus = 'SHADOW_USE' | 'RECONCILED' | 'DISPUTED';

export interface ShadowUseRow {
  id: string;
  ticketId: string | null;
  seId: string | null;
  componentId: string | null;
  componentName: string | null;
  qty: number;
  companyName: string | null;
  zoneName: string | null;
  status: string;
  reason: string | null;
  /** 'ZONAL_MANAGER' on a disputed row — who it was escalated to; null otherwise. */
  escalatedTo: string | null;
  /** The Warehouse Manager who took the decision. */
  escalatedBy: string | null;
  escalatedAt: string | null;
  createdAt: string;
  ageDays: number;
}

export async function apiShadowUse(status?: ShadowUseStatus): Promise<ShadowUseRow[]> {
  const query = status ? `?status=${status}` : '';
  const res = await fetch(`${BASE_URL}/warehouse/shadow-use${query}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as ShadowUseRow[];
}

/** Disputes escalated to the Zonal Manager — zone-clamped server-side for a ZM (#353 AC3). */
export const apiShadowUseDisputes = () => apiShadowUse('DISPUTED');

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
