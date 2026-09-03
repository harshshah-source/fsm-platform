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
  /** #358 — the live ticket status; `ESCALATED` is the one state the de-escalate door accepts. */
  ticketStatus: string;
  /** #357 — the LIVE escalation verdict: set by escalate, cleared by de-escalate. */
  escalationReason: string | null;
  /** #358 — `snapshot_runs.data_as_of` this read was answered against (global; same on every row). */
  telemetryAsOf: string | null;
  /** #358 — the sweep cannot conclude this window: telemetry has not advanced past its start. */
  stalled: boolean;
}

/**
 * One row of the zone-scoped Phase-1 fraud queue (`GET /verification/fraud-flags`, scoped by #357).
 * A separate read from `review()` with its own columns, so the Fraud-flagged tab renders THIS rather
 * than a filtered copy of the review list — which is what made the queue invisible before #358.
 */
export interface FraudFlagRow {
  ticketId: string;
  deviceId: string;
  firstPingDistanceMeters: number | null;
  outcome: string | null;
  outcomeAt: string | null;
  zoneId: string;
  zoneName: string;
  escalationReason: string | null;
  ticketStatus: string;
}

export async function apiFraudFlags(): Promise<FraudFlagRow[]> {
  const res = await fetch(`${BASE_URL}/verification/fraud-flags`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as FraudFlagRow[];
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

/**
 * #357 — reverse an escalation raised in error, back to the state the ticket was escalated FROM.
 * `reason` is mandatory (400 without one) and the door 409s on anything not currently ESCALATED,
 * which is why the page offers it on ESCALATED rows only.
 */
export async function apiDeescalate(ticketId: string, reason: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/verification/${encodeURIComponent(ticketId)}/deescalate`, {
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
