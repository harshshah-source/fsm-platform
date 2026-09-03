// Typed client for the system-triggered intra-day CRITICAL insertion ledger (Issues 29/30, retired to
// direct-assignment by #268). Reads `intraday_insertions` rows: `ASSIGNED_DIRECT` (the sweep assigned
// the ticket directly) and `ESCALATION_REQUIRED` (no capacity-eligible SE — a ZM alert also fired).
// Zone-scoped server-side (ZM own-zone; CSM / Operations Head all zones), same as `/intraday-updates`.
//
// #268 closes a gap #197's audit found: this data source existed and was never bound into the admin
// Intra-day Queue page (FE-13's own docstring said the binding would land "with Issue 29" and it never
// did — zero `intraday-insertions` references in `apps/admin` before this file). `IntradayQueuePage`
// merges these rows with the ZM manual-update rows into one table.

import {
  DeferralConflictError,
  type DeferralConflict,
  type DeferralOverride,
} from './schedules';
import type { CandidateRow } from './candidates';
import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

/** #341 — the shared builder plus this client's JSON content type. */
function jsonHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = authHeaders();
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

export type IntradayInsertionStatus =
  | 'PENDING_ACCEPTANCE'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'TIMED_OUT'
  | 'ESCALATION_REQUIRED'
  | 'ASSIGNED_DIRECT';

export interface IntradayInsertionRow {
  insertionId: string;
  ticketId: string;
  zoneId: string;
  companyId: string;
  companyTier: string;
  insertionType: string;
  slaBucket: string | null;
  /** null on an ESCALATION_REQUIRED row — no capacity-eligible SE existed to name. */
  offeredSeId: string | null;
  offeredAt: string;
  acceptanceDeadline: string | null;
  status: IntradayInsertionStatus;
  declineReasonCode: string | null;
  retryCount: number;
  whatsappSent: boolean;
  createdAt: string;
  /**
   * #288 — the engineer this ticket is live on right now, or null when it is on nobody's plan.
   *
   * Not `offeredSeId` under another name: that is who was *offered* the work. This is who *holds* it,
   * and a non-null value means the queue's Assign cannot resolve the row — `assignTicket` refuses an
   * assigned ticket — so the action offered has to be a reassign on that engineer's day plan instead.
   */
  assignedSeId: string | null;
  assignedSeName: string | null;
}

/**
 * #356 — what the queue may ask for. `take` is advisory: the server clamps it and reports back what it
 * actually applied in `limit`, so a client cannot talk itself into an unbounded read.
 */
export interface IntradayQuery {
  take?: number;
  status?: IntradayInsertionStatus[];
  /** ISO instant — the queue's "today only" / "since this morning" filter. */
  since?: string;
  cursor?: string;
}

export interface IntradayInsertionPage {
  rows: IntradayInsertionRow[];
  /** Non-null when more rows exist behind this page — pass it back as `cursor`. */
  nextCursor: string | null;
  limit: number;
}

/** Shared by both intra-day clients: only the parameters actually set reach the URL. */
export function intradayQueryString(q: IntradayQuery): string {
  const params = new URLSearchParams();
  if (q.take != null) params.set('take', String(q.take));
  if (q.status && q.status.length > 0) params.set('status', q.status.join(','));
  if (q.since) params.set('since', q.since);
  if (q.cursor) params.set('cursor', q.cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * The Intra-day Queue's insertion page. Returns an envelope rather than an array since #356: the
 * server bounds this read, and a truncated array that cannot say it was truncated is worse than the
 * unbounded one it replaced — a dispatcher would read "that is all of it" off a list that is not.
 */
export async function apiIntradayInsertions(query: IntradayQuery = {}): Promise<IntradayInsertionPage> {
  const res = await fetch(`${BASE_URL}/intraday-insertions${intradayQueryString(query)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as IntradayInsertionPage;
}

/**
 * Candidate SEs for the manual-assign modal (Issue 30, row shape by #277) — #274's candidate row,
 * never a bare id.
 */
export async function apiAvailableSes(insertionId: string): Promise<CandidateRow[]> {
  const res = await fetch(`${BASE_URL}/intraday-insertions/${insertionId}/available-ses`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as CandidateRow[];
}

export interface ManualAssignOk {
  result: 'OK';
  insertionId: string;
  scheduleId: string;
  batchId: string;
  seId: string;
}

/** Resolve an escalated insertion by hand from the Intra-day Queue (Issue 30). */
export async function apiManualAssign(
  insertionId: string,
  seId: string,
  deferral: DeferralOverride = {},
): Promise<ManualAssignOk> {
  const res = await fetch(`${BASE_URL}/intraday-insertions/${insertionId}/manual-assign`, {
    method: 'POST',
    headers: jsonHeaders(true),
    body: JSON.stringify({ seId, ...deferral }),
  });
  if (res.status === 409) {
    const body = (await res.json()) as DeferralConflict | { code?: string };
    if (body?.code === 'CONFLICT_DEFERRED') throw new DeferralConflictError(body as DeferralConflict);
    throw new Error(`REQUEST_FAILED_${res.status}`);
  }
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as ManualAssignOk;
}
