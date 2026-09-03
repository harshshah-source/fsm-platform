import { authHeaders } from './authHeaders';
// Typed client for the ZM Verification Review surface (Issue 19) over the Issue 18 verification_runs.
// Zone scope is enforced server-side. Token comes from the same sessionStorage key AuthProvider writes.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

/** #341 — the shared builder plus this client's JSON content type. */
function jsonHeaders(json = false): Record<string, string> {
  return {
    ...authHeaders(),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

export type VerificationRowType =
  | 'PARTIAL_RECOVERY'
  | 'FAILED_NO_PINGS'
  | 'FAILED_FRAUD'
  | 'CLOSED'
  | 'CLOSED_AUTO_RECOVERY'
  | 'PENDING';

export interface VerificationReviewRow {
  ticketId: string;
  deviceId: string;
  companyName: string;
  zoneId: string;
  zoneName: string;
  outcome: string | null;
  phase: string;
  pingsReceivedCount: number;
  fraudFlag: boolean;
  firstPingDistanceMeters: number | null;
  startedAt: string;
  rowType: VerificationRowType;
  partialDeadline: string | null;
}

export interface VerificationReviewFilters {
  outcome?: string;
  companyId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export async function apiVerificationReview(filters: VerificationReviewFilters = {}): Promise<VerificationReviewRow[]> {
  const qs = new URLSearchParams();
  if (filters.outcome) qs.set('outcome', filters.outcome);
  if (filters.companyId) qs.set('companyId', filters.companyId);
  if (filters.dateFrom) qs.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) qs.set('dateTo', filters.dateTo);
  const suffix = qs.toString() ? `?${qs}` : '';
  const res = await fetch(`${BASE_URL}/verification/review${suffix}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as VerificationReviewRow[];
}

export async function apiEscalateVerification(ticketId: string, reason: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/verification/${encodeURIComponent(ticketId)}/escalate`, {
    method: 'POST',
    headers: jsonHeaders(true),
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
}

/** One ticket's latest verification run (Issue 18 `GET /tickets/:id/verification`; FE-09 Verification tab). */
export interface TicketVerification {
  ticketId: string;
  phase: string;
  pingsReceivedCount: number;
  outcome: string | null;
  fraudFlag: boolean;
  firstPingDistanceMeters: number | null;
  badge: string;
}

/** Returns the run, or `null` when the backend reports no run yet (404 NO_VERIFICATION_RUN). */
export async function apiTicketVerification(ticketId: string): Promise<TicketVerification | null> {
  const res = await fetch(`${BASE_URL}/tickets/${encodeURIComponent(ticketId)}/verification`, { headers: authHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as TicketVerification;
}

/** `reason` is mandatory since #357 — the door 400s without one, as Escalate's already did. */
export async function apiMarkAutoRecovery(ticketId: string, reason: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/verification/${encodeURIComponent(ticketId)}/mark-auto-recovery`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
}
