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
  | { result: 'NOT_HOLDABLE'; status: string; assignmentState: string }
  | { result: 'CONFLICT_VEHICLE_UNAVAILABLE'; expectedFrom: string; reportId: string };

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
export function placeHold(input: {
  ticketId: string;
  heldUntil: string;
  reasonCode: string;
  confirm?: boolean;
}): Promise<HoldResult> {
  return post<HoldResult>('/schedules/holds', input);
}

export function releaseHold(ticketId: string): Promise<ReleaseResult> {
  return post<ReleaseResult>('/schedules/holds/release', { ticketId });
}
