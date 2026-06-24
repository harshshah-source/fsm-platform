// Typed client for ZM Leave Request approvals (Issue 26, `/api/leave-requests`). Zone-scoped list +
// Approve / Reject. Manager roles read; ZM / CSM decide (server-enforced).

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export interface LeaveRequestRow {
  id: string;
  seId: string;
  seName: string;
  type: string;
  status: string;
  windowStart: string;
  windowEnd: string;
  reason: string | null;
  decisionReason: string | null;
  createdAt: string;
}

export async function apiLeaveRequests(): Promise<LeaveRequestRow[]> {
  const res = await fetch(`${BASE_URL}/leave-requests`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as LeaveRequestRow[];
}

async function post(id: string, action: 'approve' | 'reject', body?: unknown): Promise<void> {
  const res = await fetch(`${BASE_URL}/leave-requests/${id}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
}

export const apiApproveLeave = (id: string) => post(id, 'approve');
export const apiRejectLeave = (id: string, reason: string) => post(id, 'reject', { reason });
