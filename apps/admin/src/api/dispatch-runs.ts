// Typed client for the `/api/dispatch-runs/*` Batch-Assignment transparency read surface (Issue 123).
// Mirrors the backend DispatchTransparencyQueryService view types. A ZONAL_MANAGER is zone-clamped
// server-side at every level, so the UI never needs to filter by zone — and never renders a
// foreign-zone link (the zone-detail route would 403 via the global ZoneScopeGuard).

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

async function get<T>(path: string): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as T;
}

export type DispatchRunTrigger = 'CRON' | 'MANUAL';
export type DispatchRunStatus = 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED';
export type DispatchZoneMode = 'DEFICIT' | 'PREVENTIVE';
export type PoolEmptyReason = 'NO_COVERAGE' | 'ALL_DROPPED';

export interface DispatchRunListRow {
  runId: string;
  trigger: DispatchRunTrigger;
  actorRole: string | null;
  actorName: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: DispatchRunStatus;
  zones: number;
  schedules: number;
  batches: number;
  ticketsDispatched: number;
  recommended: number;
  unassignable: number;
  errorCount: number;
}

/** Zone-level rollup: NO_COVERAGE (Ops coverage gap) vs ALL_DROPPED (filters emptied the pool). */
export interface UnassignableReasons {
  NO_COVERAGE: number;
  ALL_DROPPED: number;
  dropBuckets: Record<string, number>;
}

export interface DispatchRunZoneCard {
  zoneId: string;
  zoneName: string | null;
  mode: DispatchZoneMode | null;
  weightSetRef: string | null;
  ticketsConsidered: number;
  recommended: number;
  unassignable: number;
  unassignableReasons: UnassignableReasons | null;
  schedules: number;
  batches: number;
  ticketsDispatched: number;
  error: string | null;
}

/** The run's config frozen AT RUN START. Empty priorityRules / missing settings ⇒ code defaults applied. */
export interface ConfigSnapshot {
  priorityRules: { weightSetRef: string; component: string; weight: number }[];
  settings: Record<string, string>;
  capacity: Record<string, { dailyCapacity: number | null; isActive: boolean }>;
  scheduler: { businessSweepsEnabled: boolean; dispatchCron: string };
}

export interface DispatchRunDetail extends Omit<DispatchRunListRow, 'zones'> {
  actorUserId: string | null;
  configSnapshot: ConfigSnapshot;
  /** Per-zone cards — a ZM sees only their own. */
  zones: DispatchRunZoneCard[];
}

export interface DispatchBatchRow {
  batchId: string;
  scheduleId: string;
  seId: string;
  seName: string | null;
  plantId: string;
  plantName: string;
  stopSequence: number;
  status: string;
  ticketCount: number;
  capacityUsed: { used: number; cap: number | null };
}

export interface DispatchUnassignableRow {
  ticketId: string;
  deviceId: string | null;
  plantId: string | null;
  plantName: string | null;
  poolEmptyReason: PoolEmptyReason | null;
  dropCounts: Record<string, number>;
}

export interface DispatchZoneDetail {
  runId: string;
  zone: DispatchRunZoneCard;
  batches: DispatchBatchRow[];
  unassignable: DispatchUnassignableRow[];
}

export interface DispatchAssignmentRow {
  ticketId: string;
  deviceId: string | null;
  plantId: string;
  seId: string;
  sortOrder: number;
  /** Canonical processing rank (null for pre-ledger rows). */
  rank: number | null;
  score: number | null;
  /** True ⇒ all candidates scored identically (precedence decided); hide the numeric score. */
  scoreDegenerate: boolean | null;
  recStatus: string | null;
  ticketStatus: string;
  hasTrace: boolean;
}

export interface DispatchBatchDetail {
  runId: string;
  batchId: string;
  scheduleId: string;
  zoneId: string;
  seId: string;
  seName: string | null;
  plantId: string;
  plantName: string;
  rows: DispatchAssignmentRow[];
}

export interface TraceRunnerUp {
  seId: string;
  coverageType: string;
  precedenceRank: number;
  verdict: 'PASSED' | 'DROPPED';
  dropReason: string | null;
  plannerPlanned: boolean;
  score: number | null;
}

export interface TraceChosen {
  seId: string;
  coverageType: string;
  precedenceRank: number;
  plannerPlanned: boolean;
  plannerBias: boolean;
  capacityAtDecision: { used: number; cap: number | null };
  clusterSeed: boolean;
}

export interface DecisionTrace {
  candidatesTotal: number;
  passedCount: number;
  dropCounts: Record<string, number>;
  chosen: TraceChosen | null;
  runnersUp: TraceRunnerUp[];
  scoreDegenerate: boolean;
  poolEmptyReason: PoolEmptyReason | null;
}

export interface DispatchTicketTrace {
  runId: string;
  ticketId: string;
  seId: string | null;
  trace: DecisionTrace;
  scoreBreakdown: Record<string, unknown> | null;
  recStatus: string | null;
  /** seId → display name for every SE named in the trace (chosen + runners-up). */
  seNames: Record<string, string | null>;
}

export const apiDispatchRuns = (limit?: number) =>
  get<DispatchRunListRow[]>(`/dispatch-runs${limit ? `?limit=${limit}` : ''}`);

export const apiDispatchRunDetail = (runId: string) => get<DispatchRunDetail>(`/dispatch-runs/${runId}`);

export const apiDispatchZoneDetail = (runId: string, zoneId: string) =>
  get<DispatchZoneDetail>(`/dispatch-runs/${runId}/zones/${zoneId}`);

export const apiDispatchBatchDetail = (runId: string, batchId: string) =>
  get<DispatchBatchDetail>(`/dispatch-runs/${runId}/batches/${batchId}`);

export const apiDispatchTicketTrace = (runId: string, ticketId: string) =>
  get<DispatchTicketTrace>(`/dispatch-runs/${runId}/tickets/${ticketId}/trace`);
