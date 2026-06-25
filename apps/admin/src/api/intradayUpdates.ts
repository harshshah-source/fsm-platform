// Typed client for the Intra-day Queue (Issue 31). Reads the ZM manual same-day updates
// (MANUAL_ZM_UPDATE: ADD / REMOVE / REORDER), zone-scoped server-side (ZM own-zone; CSM / Operations
// Head all zones). System-triggered CRITICAL insertions (Issue 29) land in the same view later.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type IntradayUpdateType = 'ADD' | 'REMOVE' | 'REORDER';

export interface IntradayUpdateRow {
  auditId: string;
  actorId: string;
  actorRole: string;
  updateType: IntradayUpdateType;
  ticketId: string | null;
  seId: string | null;
  createdAt: string;
}

export async function apiIntradayUpdates(): Promise<IntradayUpdateRow[]> {
  const res = await fetch(`${BASE_URL}/intraday-updates`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as IntradayUpdateRow[];
}
