// Typed client for the Non-Operational dual-confirmation surface (Issue 35, `/api/non-op`). Managers
// request a marking and perform the manager confirmation leg; Operations Head can override-confirm
// after 7 days. Uses the shared authHeaders so a CSM / Operations Head acting in a ZM's zone has
// `acted_as_role` audited (Issue 47/27).

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export type NonOpState = 'AWAITING_ZM_CONFIRMATION' | 'AWAITING_CUSTOMER_CONFIRMATION' | 'CONFIRMED';

export type NonOpReason =
  | 'VEHICLE_SCRAPPED'
  | 'VEHICLE_SOLD'
  | 'VEHICLE_ACCIDENT'
  | 'COMPANY_PAUSED'
  | 'DEVICE_REPLACEMENT_PENDING'
  | 'COMPLIANCE_HOLD'
  | 'OTHER';

/** Reasons that, for a RECURRING device, auto-create a Recovery Ticket on confirmation (CONTEXT §14). */
export const RECOVERY_REASONS: readonly NonOpReason[] = [
  'VEHICLE_SCRAPPED',
  'VEHICLE_SOLD',
  'COMPANY_PAUSED',
  'DEVICE_REPLACEMENT_PENDING',
];

export interface NonOpQueueRow {
  markingId: string;
  deviceId: string;
  state: NonOpState;
  reasonCode: NonOpReason | null;
  reasonText: string | null;
  dealTypeAtMarking: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  awaitingSince: string | null;
  recoveryTicketId: string | null;
  daysElapsed: number;
}

export interface RequestNonOpBody {
  deviceId: string;
  reasonCode: NonOpReason;
  reasonText?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface DeviceDealType {
  deviceId: string;
  dealType: 'RECURRING' | 'ONE_TIME' | null;
}

function jsonHeaders(): Record<string, string> {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

export async function apiNonOpQueue(): Promise<NonOpQueueRow[]> {
  const res = await fetch(`${BASE_URL}/non-op/queue`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as NonOpQueueRow[];
}

export async function apiRequestNonOp(body: RequestNonOpBody): Promise<NonOpQueueRow> {
  const res = await fetch(`${BASE_URL}/non-op`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as NonOpQueueRow;
}

export async function apiConfirmNonOp(markingId: string): Promise<NonOpQueueRow> {
  const res = await fetch(`${BASE_URL}/non-op/${markingId}/confirm`, { method: 'POST', headers: jsonHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as NonOpQueueRow;
}

export async function apiOverrideConfirmNonOp(markingId: string, reason: string): Promise<NonOpQueueRow> {
  const res = await fetch(`${BASE_URL}/non-op/${markingId}/override-confirm`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as NonOpQueueRow;
}

export async function apiGetDeviceDealType(deviceId: string): Promise<DeviceDealType> {
  const res = await fetch(`${BASE_URL}/devices/${deviceId}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as DeviceDealType;
}
