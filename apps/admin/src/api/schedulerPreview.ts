// Typed client for the Scheduler Preview (#251) — `/api/schedules/preview` plus the two hold writes.
// Read scope is server-side: a ZM receives their own zone only, CSM/OH every active zone.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

/** One ticket's projected decision — mirrors the persisted decision-trace shape (#250). */
export interface PreviewDecision {
  ticketId: string;
  plantId: string;
  processingRank: number;
  companyTier: string;
  deviceBucket: string | null;
  tierOverrideId: string | null;
  /** null ⟺ unassignable; `poolEmptyReason` says which kind. */
  seId: string | null;
  coverageType: string | null;
  score: number | null;
  candidatesTotal: number;
  passedCount: number;
  dropCounts: Record<string, number>;
  poolEmptyReason: 'NO_COVERAGE' | 'ALL_DROPPED' | null;
  plannerBias: boolean;
  clusterSeed: boolean;
  capacityAtDecision: { used: number; cap: number | null } | null;
}

export interface PreviewPlanStop {
  plantId: string;
  ticketIds: string[];
}

export interface PreviewPlanEntry {
  seId: string;
  plants: PreviewPlanStop[];
}

export interface ZoneProjection {
  zoneId: string;
  targetDate: string;
  /** Recompute watermark for the ranking inputs — rendered as the as-of caveat, never hidden. */
  bucketsAsOf: string | null;
  mode: string;
  recommended: number;
  unassignable: number;
  withheldBelowThreshold: number;
  decisions: PreviewDecision[];
  plan: PreviewPlanEntry[];
}

export interface HoldInForce {
  ticketId: string;
  /** The day the ticket returns — inclusive, so it IS dispatchable on this date. */
  heldUntil: string;
  zoneId: string;
  plantName: string;
  deviceId: string | null;
}

export interface SchedulerPreviewResult {
  targetDate: string;
  zones: ZoneProjection[];
  holds: HoldInForce[];
  /** Oldest watermark across zones — the honest bound on how current the whole picture is. */
  bucketsAsOf: string | null;
  previewToken: string;
  errors: { zoneId: string; message: string }[];
}

export type HoldResult =
  | { result: 'OK'; ticketId: string; heldUntil: string }
  | { result: 'NOT_FOUND' }
  | { result: 'NOT_HOLDABLE'; status: string; assignmentState: string; message: string }
  | {
      result: 'CONFLICT_VEHICLE_UNAVAILABLE';
      expectedFrom: string;
      reportId: string;
      message: string;
    };

export type ReleaseResult =
  | { result: 'OK'; ticketId: string }
  | { result: 'NOT_FOUND' }
  | { result: 'NOT_HELD' };

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

/** Project the run for an IST calendar date (`YYYY-MM-DD`). Writes nothing, server-side (#250 AC-1). */
export function getSchedulerPreview(date: string): Promise<SchedulerPreviewResult> {
  return get<SchedulerPreviewResult>(`/schedules/preview?date=${encodeURIComponent(date)}`);
}

/**
 * Hold an OPEN + UNASSIGNED ticket out of the runs before `heldUntil`.
 *
 * `confirm` is required only to override a ticket that carries an open vehicle-unavailability
 * report — the server refuses that case first and returns the return-date context, so the operator
 * decides knowingly rather than discovering it afterwards.
 */
export async function placeHold(input: {
  ticketId: string;
  heldUntil: string;
  reasonCode: string;
  confirm?: boolean;
}): Promise<HoldResult> {
  const res = await fetch(`${BASE_URL}/schedules/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input),
  });
  // The two refusals are **409 bodies, not failures** — the backend says so in its own words
  // ("returned as a 409 body rather than thrown away: the client needs the return-date context to show
  // the operator what they would be overwriting before offering the confirm"). Routing them through the
  // shared `post` helper threw on `!res.ok`, so both variants declared in `HoldResult` were unreachable
  // and every refusal surfaced as a bare `REQUEST_FAILED_409`. Read them.
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
      status?: string;
      assignmentState?: string;
      expectedFrom?: string;
      reportId?: string;
    };
    if (body.code === 'CONFLICT_VEHICLE_UNAVAILABLE') {
      return {
        result: 'CONFLICT_VEHICLE_UNAVAILABLE',
        expectedFrom: String(body.expectedFrom ?? ''),
        reportId: String(body.reportId ?? ''),
        message: String(body.message ?? 'A vehicle-unavailability report already sets this return date.'),
      };
    }
    return {
      result: 'NOT_HOLDABLE',
      status: String(body.status ?? ''),
      assignmentState: String(body.assignmentState ?? ''),
      message: String(body.message ?? 'This ticket cannot be held.'),
    };
  }
  if (res.status === 404) return { result: 'NOT_FOUND' };
  // #310 — a 400 here is a *refusal with a stated reason* (`INVALID_DATE`: the date names a day the
  // hold would not survive), not a transport failure. Same treatment `apiOverrideBatch` already gives
  // `TARGET_DATE_IN_PAST`, and for the same reason: the server has already written the sentence the
  // operator needs, and `REQUEST_FAILED_400` throws it away. Reachable despite the input's `min`,
  // which is computed when the panel renders — a console left open past IST midnight offers a date
  // that was future when it was drawn and is not when it is sent.
  if (res.status === 400) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message || 'That date would not hold the ticket back.');
  }
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as HoldResult;
}

export function releaseHold(ticketId: string): Promise<ReleaseResult> {
  return post<ReleaseResult>('/schedules/holds/release', { ticketId });
}
