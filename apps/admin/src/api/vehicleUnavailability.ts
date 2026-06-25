// Typed client for the ZM Vehicle Unavailability Review surface (Issue 28). Manager-only reads of
// OPEN reports with BOTH SLA clocks (the secondary, never-pausing clock lives only on this
// manager-gated endpoint), plus the ZM legs: confirm/edit the expected-availability date and
// manually resume the primary SLA (which resolves the report). Manager roles only — enforced
// server-side (ZONAL_MANAGER own-zone; CSM / OPERATIONS_HEAD all zones).

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

export interface VehicleUnavailRow {
  id: string;
  ticketId: string;
  seId: string;
  plantName: string;
  reasonCode: VehicleUnavailReason;
  transporterContacted: boolean;
  expectedFrom: string;
  expectedTo: string | null;
  notes: string | null;
  status: string;
  slaPaused: boolean;
  /** Effective (pausable) SLA elapsed seconds. */
  primarySlaSeconds: number;
  /** True elapsed seconds from the Failure Cycle's opened_at — never pauses (manager-only). */
  secondarySlaSeconds: number;
  createdAt: string;
}

export async function apiVehicleUnavailability(): Promise<VehicleUnavailRow[]> {
  const res = await fetch(`${BASE_URL}/vehicle-unavailability`, { headers: authHeaders() });
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

export const apiConfirmVuDate = (id: string, expectedFrom: string) => post(`${id}/confirm-date`, { expectedFrom });
export const apiResumeVuSla = (id: string) => post(`${id}/resume-sla`);
