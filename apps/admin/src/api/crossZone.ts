// Typed client for the cross-zone escalation surface (Issue 32, `/api/cross-zone`). Consumed by the
// Issue 78 admin page. Reuses the shared `authHeaders` so a CSM / Operations Head acting in a ZM's
// scope is attributed correctly. Presentation-only — no business logic here.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

/** One cross-zone escalation row (mirrors backend `CrossZoneEscalationRow`). */
export interface CrossZoneRow {
  escalationId: string;
  ticketId: string;
  homeZoneId: string;
  companyId: string;
  companyTier: string;
  escalationType: 'AUTO_PLATINUM' | 'MANUAL_FLAG';
  status: string;
  triggerBucket: string | null;
  flagReason: string | null;
  decisionReason: string | null;
  reviewDate: string | null;
  targetZoneId: string | null;
  assignedSeId: string | null;
  raisedByRole: string | null;
  createdAt: string;
}

export async function apiCrossZoneList(): Promise<CrossZoneRow[]> {
  const res = await fetch(`${BASE_URL}/cross-zone`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as CrossZoneRow[];
}

export async function apiCrossZoneSweep(zoneId?: number): Promise<{ escalated: number }> {
  return (await post('/cross-zone/sweep', zoneId != null ? { zoneId } : {})) as { escalated: number };
}

export async function apiCrossZoneFlag(ticketId: string, reason: string): Promise<unknown> {
  return post('/cross-zone/flag', { ticketId, reason });
}

export async function apiCrossZoneApprove(id: string, targetZoneId: number, seId: string): Promise<unknown> {
  return post(`/cross-zone/${id}/approve`, { targetZoneId, seId });
}

export async function apiCrossZoneDeny(id: string, reason: string): Promise<unknown> {
  return post(`/cross-zone/${id}/deny`, { reason });
}

export async function apiCrossZoneDefer(id: string, reviewDate: string, reason: string): Promise<unknown> {
  return post(`/cross-zone/${id}/defer`, { reviewDate, reason });
}

export async function apiCrossZoneReEscalate(id: string): Promise<unknown> {
  return post(`/cross-zone/${id}/re-escalate`);
}

async function post(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return await res.json();
}
