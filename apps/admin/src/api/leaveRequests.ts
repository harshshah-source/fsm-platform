// Typed client for ZM Leave Request approvals (Issue 26, `/api/leave-requests`). Zone-scoped list +
// Submit / Approve / Reject / Revoke. Manager roles read; ZM / CSM decide (server-enforced).

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export interface LeaveRequestRow {
  id: string;
  seId: string;
  seName: string;
  type: string;
  /** `PENDING` | `APPROVED` | `REJECTED` | `REVOKED` — the last of these is derived server-side (#363). */
  status: string;
  windowStart: string;
  windowEnd: string;
  reason: string | null;
  decisionReason: string | null;
  createdAt: string;
}

export interface SubmitLeaveBody {
  seId: string;
  type: 'ON_LEAVE' | 'WEEKLY_OFF';
  /** `YYYY-MM-DD` — the server reads a date-only value as an IST calendar day (#204). */
  windowStart: string;
  windowEnd: string;
  reason?: string | null;
}

/**
 * Carries the backend error `code` to the page — `OVERLAP` (409, the SE already holds one of those
 * days) is the one this surface has copy for, and `conflictId` names the request holding it.
 */
export class LeaveApiError extends Error {
  code: string;
  conflictId?: string;
  constructor(code: string, conflictId?: string) {
    super(code);
    this.name = 'LeaveApiError';
    this.code = code;
    this.conflictId = conflictId;
  }
}

export async function apiLeaveRequests(): Promise<LeaveRequestRow[]> {
  const res = await fetch(`${BASE_URL}/leave-requests`, { headers: authHeaders() });
  if (!res.ok) throw new LeaveApiError(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as LeaveRequestRow[];
}

async function post(path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let payload: { code?: string; conflictId?: string } = {};
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      // non-JSON error body
    }
    throw new LeaveApiError(payload.code ?? `REQUEST_FAILED_${res.status}`, payload.conflictId);
  }
}

export const apiSubmitLeave = (body: SubmitLeaveBody) => post('/leave-requests', body);
export const apiApproveLeave = (id: string) => post(`/leave-requests/${id}/approve`);
export const apiRejectLeave = (id: string, reason: string) => post(`/leave-requests/${id}/reject`, { reason });
/** #363 — undo an approval: the SE goes back on the board for that window, with a mandatory reason. */
export const apiRevokeLeave = (id: string, reason: string) => post(`/leave-requests/${id}/revoke`, { reason });
