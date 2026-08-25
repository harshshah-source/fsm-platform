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
/**
 * #261 — `ABORTED` is written only by the reaper: the run's process stopped existing, so nobody knows
 * what it did. Kept distinct from FAILED, which is a statement about the WORK (every zone tried, every
 * zone failed) — collapsing them would make "the dispatcher is broken" and "the box was restarted"
 * the same row on this list.
 */
export type DispatchRunStatus = 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'ABORTED';
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
  /**
   * #259 — what this run's claim on the zone came to: DONE / ERROR for a zone it held, CONTENDED for
   * one another run was already holding. Optional: absent when served by a backend build predating the
   * zone claim, in which case the card renders exactly as it always did.
   */
  outcome?: 'DONE' | 'ERROR' | 'CONTENDED' | 'RUNNING';
  /** #259 — for a CONTENDED zone, the run that held it. */
  contendedWithRunId?: string | null;
  /**
   * #262 — engineers this zone could not dispatch, and why. The dispatch write unit is now the SE, so
   * one engineer's conflict no longer costs the zone its day plan — but it does cost that engineer
   * theirs, and this is the only place that says so.
   */
  seSkips?: Array<{ seId: string; reason: string; constraint: string | null }>;
  /**
   * #252 (landed with #259) — the three populations the engine did NOT decide on. Each is a different
   * team's problem, so they render apart from `unassignable` and from each other. The two nullable ones
   * are `null` when the run never measured them; that reads as "not recorded", never as 0. Optional:
   * absent when served by a backend build predating the projection.
   */
  withheldBelowThreshold?: number;
  bucketlessDropped?: number | null;
  componentBlockedWithheld?: number | null;
  /**
   * #179 — LIVE counters beside the historical `ticketsDispatched`. The ledger records what the run
   * dispatched and never changes; these say how much of it is still on a day plan now vs has since
   * been pulled off (bulk unassign / ZM override — cause deliberately not attributed). Optional:
   * absent when served by a backend build predating the addition, so the note simply does not render.
   */
  ticketsStillAssigned?: number;
  ticketsRemovedSince?: number;
}

/** The run's config frozen AT RUN START. Empty priorityRules / missing settings ⇒ code defaults applied. */
export interface ConfigSnapshot {
  priorityRules: { weightSetRef: string; component: string; weight: number }[];
  settings: Record<string, string>;
  capacity: Record<string, { dailyCapacity: number | null; isActive: boolean }>;
  scheduler: { businessSweepsEnabled: boolean; dispatchCron: string };
  /** #287 — the freshness of the FLOATING candidate pool this run selected from. Absent on runs that
   *  predate the field, so a reader must treat its absence as unknown, not as fresh. */
  eligibilityMv?: {
    viewName: string;
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    lastError: string | null;
    stale: boolean;
  };
}

/** #131 — the run's build attribution against the current runtime-lock high-water mark. Null for a
 * historical run predating #130 (no build columns stamped). */
export interface DispatchRunBuildStamp {
  buildVersion: string;
  buildFingerprint: string;
  staleBuild: boolean;
  currentVersion: string;
  currentFingerprint: string;
}

export interface DispatchRunDetail extends Omit<DispatchRunListRow, 'zones'> {
  actorUserId: string | null;
  configSnapshot: ConfigSnapshot;
  /** Per-zone cards — a ZM sees only their own. */
  zones: DispatchRunZoneCard[];
  build: DispatchRunBuildStamp | null;
}

export interface DispatchBatchRow {
  batchId: string;
  scheduleId: string;
  seId: string;
  seName: string | null;
  plantId: string;
  plantName: string;
  /** Owning company for the batch (derived from its tickets; "First +N" when it spans companies). */
  companyName: string | null;
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
  companyName: string | null;
  poolEmptyReason: PoolEmptyReason | null;
  dropCounts: Record<string, number>;
}

/** Fleet device stats for a plant dispatched in a zone — device totals/inactive + assignment split. */
export interface PlantDeviceStats {
  totalDevices: number;
  inactiveDevices: number;
  assignedDevices: number;
  unassignedDevices: number;
}

export interface DispatchZoneDetail {
  runId: string;
  zone: DispatchRunZoneCard;
  batches: DispatchBatchRow[];
  unassignable: DispatchUnassignableRow[];
  /** plantId → fleet device stats for every plant dispatched in this zone. */
  plantStats: Record<string, PlantDeviceStats>;
}

export interface DispatchAssignmentRow {
  ticketId: string;
  deviceId: string | null;
  companyName: string | null;
  vehicleNo: string | null;
  transporterName: string | null;
  /**
   * AutoPlant device context. Optional: absent when served by a backend build predating the enrichment
   * (version skew) — the columns then render "—" rather than blanking the table.
   */
  deviceType?: string | null;
  imsiNo?: string | null;
  /** Last GPS ping; Inactive Duration is derived from it (same rule as the device list). */
  latestGpsDatetime?: string | null;
  tripCreationDatetime?: string | null;
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
  /** The run behind the batch's schedule — null for pre-ledger / ZM_MANUAL schedules. The batch still
   * resolves (it is addressed by its own id); only the run-keyed decision trace is unavailable. */
  runId: string | null;
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
  /**
   * #266 — three outcomes, not two. `TIER_NOT_REACHED` is a candidate that passed every hard filter
   * but sits below the winning coverage tier, so it was never scored: the tier is decided first and
   * the score is only ever consulted inside it. It is not a near-miss and not a rejection.
   */
  verdict: 'PASSED' | 'DROPPED' | 'TIER_NOT_REACHED';
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
  /** #266 — the winner's own score, so it can be read against the runners-up. Absent on older runs. */
  score?: number | null;
  /** #266 — the coverage tier the score was consulted within. Absent on older runs. */
  tierEvaluated?: string | null;
}

export interface DecisionTrace {
  candidatesTotal: number;
  passedCount: number;
  dropCounts: Record<string, number>;
  chosen: TraceChosen | null;
  runnersUp: TraceRunnerUp[];
  scoreDegenerate: boolean;
  poolEmptyReason: PoolEmptyReason | null;
  /** #270 — filters this ticket could not enforce for real (Issue 28/22's feeds are unbuilt).
   *  Absent on older runs (version skew). Never rendered as a pass. */
  notEnforcedFilters?: string[];
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
  /**
   * Full ticket identity for the "why this SE" strip — read context without navigating away.
   * Optional: absent when served by a backend build predating the enrichment (version skew).
   */
  identity?: {
    deviceId: string | null;
    vehicleNo: string | null;
    plantName: string | null;
    companyName: string | null;
    transporterName: string | null;
  };
}

/**
 * #284 §C — one decision a run made, as Replay lists it.
 *
 * Flat and small by design: the stream is the whole run, and the deep "why this SE" view already
 * exists as the per-ticket trace this row expands into.
 */
export interface DispatchDecisionRow {
  ticketId: string;
  zoneId: string;
  /** The engine's own processing order — what makes this a replay rather than a report. */
  processingRank: number | null;
  /** `SUGGESTED` | `DISPATCHED` | `UNASSIGNABLE` | `RETIRED`. */
  status: string | null;
  seId: string | null;
  seName: string | null;
  plantId: string | null;
  plantName: string | null;
  deviceId: string | null;
  companyTier: string | null;
  deviceBucket: string | null;
  /** `NO_COVERAGE` | `ALL_DROPPED` on an unassignable decision; null when an SE was chosen. */
  poolEmptyReason: string | null;
  candidatesTotal: number | null;
  passedCount: number | null;
}

export interface DispatchRunDecisions {
  runId: string;
  /** Decisions in scope before paging, so the page can say "20 of 340" honestly. */
  total: number;
  limit: number;
  offset: number;
  rows: DispatchDecisionRow[];
}

export const apiDispatchRuns = (limit?: number) =>
  get<DispatchRunListRow[]>(`/dispatch-runs${limit ? `?limit=${limit}` : ''}`);

export const apiDispatchRunDetail = (runId: string) => get<DispatchRunDetail>(`/dispatch-runs/${runId}`);

export const apiDispatchZoneDetail = (runId: string, zoneId: string) =>
  get<DispatchZoneDetail>(`/dispatch-runs/${runId}/zones/${zoneId}`);

/** A batch is addressed by its own id, not via its run — most live batches have no `run_id`. */
export const apiDispatchBatchDetail = (batchId: string) => get<DispatchBatchDetail>(`/batches/${batchId}`);

export const apiDispatchTicketTrace = (runId: string, ticketId: string) =>
  get<DispatchTicketTrace>(`/dispatch-runs/${runId}/tickets/${ticketId}/trace`);

/** #284 §C — a page of a run's decisions, in `processing_rank` order. */
export const apiDispatchRunDecisions = (
  runId: string,
  opts: { zoneId?: string; limit?: number; offset?: number } = {},
) => {
  const params = new URLSearchParams();
  if (opts.zoneId) params.set('zoneId', opts.zoneId);
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.offset != null) params.set('offset', String(opts.offset));
  const qs = params.toString();
  return get<DispatchRunDecisions>(`/dispatch-runs/${runId}/decisions${qs ? `?${qs}` : ''}`);
};
