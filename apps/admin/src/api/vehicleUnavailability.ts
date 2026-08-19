// Typed client for the ZM Vehicle Unavailability Review surface (Issue 28, extended by #245).
// Manager-only reads of the live reports (plus a bounded resumed tail) with BOTH SLA clocks — the
// secondary, never-pausing clock lives only on this manager-gated endpoint — and the manager legs:
// approve the SE's proposed return date, override it with a reason, read a ticket's supersession
// history, or manually resume the primary SLA (which resolves the report). Manager roles only —
// enforced server-side (ZONAL_MANAGER own-zone; CSM / OPERATIONS_HEAD all zones).
//
// `confirm-date` is gone (#245). It rewrote the authoritative date in place with no audit row and no
// memory of what the SE had reported; approve and override replace it, and both are audited. The
// endpoint answers 410 rather than 404 so a stale client learns why its write did nothing.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type VehicleUnavailReason =
  | 'VEHICLE_ON_TRIP'
  | 'VEHICLE_NOT_AT_PLANT'
  | 'DRIVER_NOT_AVAILABLE'
  | 'CUSTOMER_REFUSED'
  | 'OTHER';

/** `null` until an in-scope manager has decided (#245). */
export type VuDecision = 'APPROVED' | 'OVERRIDDEN' | null;

export interface VehicleUnavailRow {
  id: string;
  ticketId: string;
  seId: string;
  plantName: string;
  reasonCode: VehicleUnavailReason;
  transporterContacted: boolean;
  /** The SE's entry, immutable — what the field actually reported (#245). */
  proposedFrom: string;
  /** The authoritative return date: the proposal, until a manager overrides it. */
  expectedFrom: string;
  expectedTo: string | null;
  notes: string | null;
  status: string;
  decision: VuDecision;
  decidedBy: string | null;
  decidedByRole: string | null;
  decidedAt: string | null;
  overrideReason: string | null;
  slaPaused: boolean;
  /** Effective (pausable) SLA elapsed seconds. */
  primarySlaSeconds: number;
  /** True elapsed seconds from the Failure Cycle's opened_at — never pauses (manager-only). */
  secondarySlaSeconds: number;
  resolvedAt: string | null;
  createdAt: string;
}

export async function apiVehicleUnavailability(): Promise<VehicleUnavailRow[]> {
  const res = await fetch(`${BASE_URL}/vehicle-unavailability`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as VehicleUnavailRow[];
}

/** Every report this report's ticket has ever carried, newest first — the supersession chain. */
export async function apiVuHistory(id: string): Promise<VehicleUnavailRow[]> {
  const res = await fetch(`${BASE_URL}/vehicle-unavailability/${id}/history`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as VehicleUnavailRow[];
}

async function post(path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${BASE_URL}/vehicle-unavailability/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
}

export const apiApproveVuDate = (id: string) => post(`${id}/approve`);
export const apiOverrideVuDate = (id: string, expectedFrom: string, reason: string) =>
  post(`${id}/override`, { expectedFrom, reason });
export const apiResumeVuSla = (id: string) => post(`${id}/resume-sla`);
