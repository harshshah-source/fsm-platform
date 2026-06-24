// Typed client for the ticket read surface (Issue 05 `/api/tickets`). Used by the dashboard's
// company → plant → device drill-down to load a plant's devices.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

export interface TicketRow {
  ticketId: string;
  workType: string;
  status: string;
  deviceId: string;
  plantId: string;
  companyId: string;
  companyTier: string;
  assignmentState: string;
  slaBucket: string | null;
  repeatFailure: boolean;
  failureCycleState: string | null;
  /** Issue 23 — latest Component Request status + the SLA-pause timestamp for the WAITING_COMPONENT flag. */
  componentRequestStatus?: string | null;
  waitingComponentSince?: string | null;
  createdAt: string;
}

export interface TicketLifecycleEvent {
  fromState: string | null;
  toState: string;
  actorId: string | null;
  actorRole: string | null;
  actedAsRole: string | null;
  reasonCode: string | null;
  at: string;
}

export interface TicketDetail extends TicketRow {
  vehicleId: string | null;
  failureCycleId: string | null;
  lastStateChangedAt: string;
  lifecycle: TicketLifecycleEvent[];
}

export interface TicketFilters {
  workType?: string;
  status?: string;
  companyId?: string;
  plantId?: string;
  assignmentState?: string;
  bucket?: string;
}

async function get<T>(path: string): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as T;
}

export function apiTicketsList(filters: TicketFilters = {}): Promise<TicketRow[]> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  const qs = q.toString();
  return get<TicketRow[]>(`/tickets${qs ? `?${qs}` : ''}`);
}

export const apiTicketDetail = (id: string) =>
  get<TicketDetail>(`/tickets/${encodeURIComponent(id)}`);

export const apiTicketsByPlant = (plantId: string) => apiTicketsList({ plantId });
