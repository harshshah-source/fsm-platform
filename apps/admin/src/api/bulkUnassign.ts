// Typed client for the OH bulk unassign / mid-day rebalance control (#179), `/api/schedules/
// bulk-unassign*` + the existing `/api/schedules/dispatch-run`. OH-only server-side (D6).

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export interface ZoneClassCounts {
  eligible: number;
  onSite: number;
  componentBlocked: number;
  closedExcluded: number;
  installRecoveryExcluded: number;
  deferredExcluded: number;
}

export interface PreviewZoneResult {
  zoneId: string;
  zoneName: string;
  counts: ZoneClassCounts;
}

export interface PreviewResult {
  operationId: string;
  previewToken: string;
  targetDate: string;
  zones: PreviewZoneResult[];
}

export interface ExecuteZoneResult {
  zoneId: string;
  zoneName: string;
  skipped: boolean;
  skipReason: string | null;
  ticketsUnassigned: number;
}

export interface ExecuteResultOk {
  result: 'OK';
  operationId: string;
  zones: ExecuteZoneResult[];
}
/** A stale preview embeds fresh counts so the caller can re-preview without a second round trip. */
export interface ExecuteResultStale {
  result: 'TOKEN_STALE';
  freshPreview: PreviewResult;
}
export type ExecuteResult = ExecuteResultOk | { result: 'TOKEN_REQUIRED' } | { result: 'TOKEN_INVALID' } | ExecuteResultStale;

export interface BulkUnassignHistoryRow {
  id: string;
  operationId: string | null;
  actorId: string;
  scope: string;
  zoneId: string;
  zoneName: string | null;
  reasonCode: string | null;
  skipped: boolean;
  skipReason: string | null;
  counts: ZoneClassCounts | null;
  ticketsUnassigned: number;
  createdAt: string;
}

export interface DispatchRunSummary {
  zones: number;
  schedules: number;
  tickets: number;
  errors: { zoneId: string; message: string }[];
  runId: string;
}

interface BulkUnassignRequestBody {
  mode: 'PREVIEW' | 'EXECUTE';
  scope: 'ZONE' | 'PAN_INDIA';
  zoneId?: number;
  reasonCode: string;
  previewToken?: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as T;
}

export const previewBulkUnassign = (input: { scope: 'ZONE' | 'PAN_INDIA'; zoneId?: number; reasonCode: string }) =>
  post<PreviewResult>('/schedules/bulk-unassign', { mode: 'PREVIEW', ...input } satisfies BulkUnassignRequestBody);

/**
 * A refused token (required/invalid/stale) comes back as a 409 whose body still carries the
 * discriminated shape (`{code, freshPreview?}`) — read it rather than throwing, so the page can
 * react (re-preview on stale) instead of just showing a generic failure.
 */
export async function executeBulkUnassign(input: {
  scope: 'ZONE' | 'PAN_INDIA';
  zoneId?: number;
  reasonCode: string;
  previewToken?: string;
}): Promise<ExecuteResult> {
  const res = await fetch(`${BASE_URL}/schedules/bulk-unassign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ mode: 'EXECUTE', ...input } satisfies BulkUnassignRequestBody),
  });
  const body = await res.json();
  if (res.ok) return body as ExecuteResultOk;
  if (body?.code === 'PREVIEW_TOKEN_REQUIRED') return { result: 'TOKEN_REQUIRED' };
  if (body?.code === 'PREVIEW_TOKEN_INVALID') return { result: 'TOKEN_INVALID' };
  if (body?.code === 'PREVIEW_TOKEN_STALE') return { result: 'TOKEN_STALE', freshPreview: body.freshPreview };
  throw new Error(`REQUEST_FAILED_${res.status}`);
}

export const listBulkUnassignHistory = () => get<BulkUnassignHistoryRow[]>('/schedules/bulk-unassign/history');

/**
 * The manual dispatch trigger. #213 — a run already in flight for the zone comes back as a 409 whose
 * body carries the operator-readable reason (which zone, since when, started by whom); read it rather
 * than throwing a generic failure, so the page can show what the server actually said.
 */
export type RunDispatchResult =
  | { result: 'OK'; summary: DispatchRunSummary }
  | { result: 'ALREADY_RUNNING'; message: string };

export async function runDispatch(zoneId?: number, reason?: string): Promise<RunDispatchResult> {
  const res = await fetch(`${BASE_URL}/schedules/dispatch-run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ ...(zoneId != null ? { zoneId } : {}), ...(reason?.trim() ? { reason: reason.trim() } : {}) }),
  });
  const body = await res.json();
  if (res.ok) return { result: 'OK', summary: body as DispatchRunSummary };
  if (body?.code === 'DISPATCH_ALREADY_RUNNING') {
    return { result: 'ALREADY_RUNNING', message: String(body.message ?? 'A dispatch run is already in flight.') };
  }
  throw new Error(`REQUEST_FAILED_${res.status}`);
}
