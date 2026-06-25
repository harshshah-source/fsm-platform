// Typed client for the Warehouse Manager Component Requests queue (Issue 22). The WM legs of the
// component-unavailable loop: list active requests, Approve, Mark Shipped (tracking + destination),
// Reject (mandatory reason). WAREHOUSE_MANAGER only — enforced server-side.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type ComponentRequestStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'SHIPPED' | 'RECEIVED';
export type DeliveryDestination = 'SE_LOCATION' | 'PLANT_WAREHOUSE';

export interface ComponentRequestRow {
  requestId: string;
  ticketId: string;
  seId: string;
  componentId: string | null;
  componentName: string | null;
  companyName: string;
  zoneName: string;
  status: ComponentRequestStatus;
  deliveryDestination: DeliveryDestination | null;
  trackingRef: string | null;
  rejectionReason: string | null;
  createdAt: string;
  ageDays: number;
}

export async function apiComponentRequests(): Promise<ComponentRequestRow[]> {
  const res = await fetch(`${BASE_URL}/warehouse/requests`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as ComponentRequestRow[];
}

// Manager read-only oversight (Issue 23): own-zone (ZM) / all-zones (CSM, OH); no mutation actions.
export async function apiComponentRequestsOversight(): Promise<ComponentRequestRow[]> {
  const res = await fetch(`${BASE_URL}/component-requests`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as ComponentRequestRow[];
}

// Per-ticket Component Requests for the Ticket Detail Components tab (Issue 62); zone-scoped, read-only.
export async function apiComponentRequestsByTicket(ticketId: string): Promise<ComponentRequestRow[]> {
  const res = await fetch(`${BASE_URL}/component-requests/by-ticket/${encodeURIComponent(ticketId)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as ComponentRequestRow[];
}

async function post(path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${BASE_URL}/warehouse/requests/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
}

export const apiApproveRequest = (id: string) => post(`${id}/approve`);
export const apiShipRequest = (id: string, ship: { trackingRef: string; deliveryDestination: DeliveryDestination }) =>
  post(`${id}/ship`, ship);
export const apiRejectRequest = (id: string, reason: string) => post(`${id}/reject`, { reason });
