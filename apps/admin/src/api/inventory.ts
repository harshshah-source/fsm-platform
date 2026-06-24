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
