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
  /**
   * #354 — which side of this escalation the reader is on. `outgoing` is work this zone sent out,
   * `incoming` is work it has been given, `null` for a pan-India reader (CSM / Operations Head), for
   * whom the row has no near side. #355 folded it in here from the page's local intersection type: the
   * backend has sent it on every row since #354, and a shared type that omits a field the wire always
   * carries makes every consumer re-declare it.
   */
  direction: 'incoming' | 'outgoing' | null;
}

/**
 * #355 — one audited step in an escalation's life (mirrors backend `CrossZoneHistoryRow`).
 *
 * The queue reads what is still open, so a decided escalation used to leave the product entirely: the
 * receiving zone could not see what had been asked of it or when, and a denial could not be read back
 * against the reason given for it.
 */
export interface CrossZoneHistoryRow {
  auditId: string;
  escalationId: string;
  ticketId: string;
  homeZoneId: string;
  targetZoneId: string | null;
  companyTier: string;
  escalationType: 'AUTO_PLATINUM' | 'MANUAL_FLAG';
  action: string;
  currentStatus: string;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decidedByRole: string | null;
  /** The backup authority the decision was taken under, if any — null for the actor's own role. */
  actedAsRole: string | null;
  actingZone: string | null;
  reason: string | null;
  at: string;
  direction: 'incoming' | 'outgoing' | null;
}

export async function apiCrossZoneList(): Promise<CrossZoneRow[]> {
  const res = await fetch(`${BASE_URL}/cross-zone`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as CrossZoneRow[];
}

/** #355 — the decision history, zone-clamped by the backend exactly as the queue read is. */
export async function apiCrossZoneHistory(range: { from?: string; to?: string; limit?: number } = {}): Promise<
  CrossZoneHistoryRow[]
> {
  const qs = new URLSearchParams();
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  if (range.limit != null) qs.set('limit', String(range.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetch(`${BASE_URL}/cross-zone/history${suffix}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as CrossZoneHistoryRow[];
}

export async function apiCrossZoneSweep(zoneId?: number): Promise<{ escalated: number }> {
  return (await post('/cross-zone/sweep', zoneId != null ? { zoneId } : {})) as { escalated: number };
}

export async function apiCrossZoneFlag(ticketId: string, reason: string): Promise<unknown> {
  return post('/cross-zone/flag', { ticketId, reason });
}

/**
 * #355 — `targetZoneId` is optional on the wire: the engineer's own zone is the target zone, so the
 * backend derives it when it is absent and 400s (`SE_NOT_IN_TARGET_ZONE`) when the two disagree. The
 * page sends both, because the operator picked both and a silent derivation would hide a mis-pick.
 */
export async function apiCrossZoneApprove(
  id: string,
  targetZoneId: number | null,
  seId: string,
): Promise<unknown> {
  return post(`/cross-zone/${id}/approve`, targetZoneId == null ? { seId } : { targetZoneId, seId });
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
