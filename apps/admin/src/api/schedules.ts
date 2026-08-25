// Typed client for the ZM Batch-Schedule monitoring + override surface (Issue 13a backend / 13b UI).
// Mirrors the backend ZmScheduleQueryService view types; token comes from the same sessionStorage key
// AuthProvider writes. Monitoring only — there is no approval gate (CONTEXT.md Decisions §7).

import { authHeaders as sharedAuthHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

/**
 * Bearer + `X-Acting-As-Zone`, from the one shared builder, plus this module's JSON opt-in.
 *
 * This file used to carry its own **bearer-only** copy, which made the Assign Work Console
 * structurally incapable of honouring acting on its own write path: the pool and candidate reads go
 * through `assignWork.ts` / `candidates.ts` (shared builder, header sent) while `assignable-tickets`,
 * `distribute-preview` and `assign-batch` live here and sent no header at all. The backend collapses
 * the acting zone for all five — so an Operations Head acting in a zone read that zone and committed
 * pan-India, and the audit row could not record that they were acting, because the request never said
 * so. Endpoints on this module that ignore the header are unaffected by sending it.
 */
function authHeaders(json = false): Record<string, string> {
  return {
    ...sharedAuthHeaders(),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as T;
}

export interface ScheduleRow {
  scheduleId: string;
  seId: string;
  /** SE display name (Issue 122b) — render this, keep seId as the key. */
  seName?: string | null;
  zoneId: string;
  zoneName?: string | null;
  dateFrom: string;
  dateTo: string;
  status: string;
  batchCount: number;
  ticketCount: number;
}

/**
 * #284 §D — `date` narrows to the plans covering that IST operating day; omitting it returns the
 * all-live list this endpoint has always returned. Additive on both sides of the wire.
 */
export const apiListSchedules = (date?: string) =>
  get<ScheduleRow[]>(`/schedules${date ? `?date=${encodeURIComponent(date)}` : ''}`);

export interface TicketReasoning {
  companyTier: string | null;
  deviceBucket: string | null;
  companyPriorityRank: string | null;
  clusterMultiplier: number | null;
}

export interface ScheduleStopTicket {
  ticketId: string;
  sortOrder: number;
  // Ungated per-ticket state (Issue 79) — the reference-12 PARTIAL / CRITICAL / tier card badges.
  // Sourced independently of `reasoning` (which stays gated behind "Why suggested?"): `slaBucket` from
  // the live device state, `companyTier` denormalised on the ticket, `partialRecovery` from a
  // PARTIAL_RECOVERY verification outcome.
  slaBucket: string | null;
  companyTier: string | null;
  partialRecovery: boolean;
  reasoning: TicketReasoning | null;
}

export interface ScheduleStop {
  batchId: string;
  stopSequence: number;
  plantId: string;
  plantName: string;
  status: string;
  deviceCount: number;
  tickets: ScheduleStopTicket[];
}

export interface ScheduleDetail {
  scheduleId: string;
  seId: string;
  seName?: string | null;
  status: string;
  dateFrom: string;
  dateTo: string;
  stops: ScheduleStop[];
}

export const apiScheduleDetail = (engineerId: string) =>
  get<ScheduleDetail>(`/schedules/${encodeURIComponent(engineerId)}`);

export interface ZoneEngineer {
  engineerId: string;
  /** SE display name (Issue 122b) — pickers should never show a bare uuid. */
  name?: string | null;
  coverageType: string;
  zoneId: string;
  /**
   * #269 — live day-plan stops the SE already carries today, from the one backend definition the
   * recommender enforces against. `dailyCapacity` shipped without this and was therefore rendered
   * nowhere; every picker fed by this type now shows `committed / dailyCapacity`.
   *
   * Optional on the client only so a surface reading a cached or older payload degrades to showing
   * the name alone rather than "undefined/6".
   */
  committed?: number;
  dailyCapacity: number;
  isActive: boolean;
}

export const apiZoneEngineers = () => get<ZoneEngineer[]>('/schedules/engineers');

export interface AssignOk {
  result: 'OK';
  scheduleId: string;
  batchId: string;
  ticketId: string;
  seId: string;
}

/** The vehicle wait behind a hold (#249/#245) — the SE's proposal beside the authoritative date. */
export interface DeferralVuContext {
  id: string;
  proposedFrom: string;
  expectedFrom: string;
}

/** 409 payload when an assign targets a ticket held to a future vehicle-return date (#249). */
export interface DeferralConflict {
  code: 'CONFLICT_DEFERRED';
  message: string;
  ticketId: string;
  deferredUntil: string;
  vuReport: DeferralVuContext | null;
}

/**
 * Thrown on the #249 409 so the caller can show what it is about to override and re-submit with
 * `confirm` + a reason — the same shape as {@link OverrideConflictError}, deliberately: one confirm
 * vocabulary across every override means a surface that handles one handles the other.
 */
export class DeferralConflictError extends Error {
  constructor(public readonly conflict: DeferralConflict) {
    super(conflict.message);
    this.name = 'DeferralConflictError';
  }
}

/** A manager's explicit decision to assign over a return-date hold (#249). */
export interface DeferralOverride {
  confirm?: boolean;
  reasonCode?: string;
}

/** Grouped Critical Work Queue one-click assign — creates a Formal Assignment (Issue 13b AC#6). */
export async function apiAssignTicket(
  ticketId: string,
  seId: string,
  deferral: DeferralOverride = {},
): Promise<AssignOk> {
  const res = await fetch(`${BASE_URL}/schedules/assign`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ ticketId, seId, ...deferral }),
  });
  if (res.status === 409) {
    const body = (await res.json()) as DeferralConflict | { code?: string };
    // 409 also carries TICKET_ALREADY_ASSIGNED; only the deferral conflict is answerable by a confirm.
    if (body?.code === 'CONFLICT_DEFERRED') throw new DeferralConflictError(body as DeferralConflict);
    throw new Error(`REQUEST_FAILED_${res.status}`);
  }
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as AssignOk;
}

/** Result of the multi-plant manual assign (Issue 122b): per-plant tallies + overall totals. */
export interface PlantAssignSummary {
  seId: string;
  assigned: number;
  alreadyAssigned: number;
  perPlant: { plantId: string; assigned: number; openUnassigned: number }[];
}

/** Manual multi-plant SE assignment (Issue 122b, Device Detail page) — assigns every OPEN +
 *  UNASSIGNED ticket at the selected plants to the SE via the canonical assignTicket flow. */
export async function apiAssignPlants(seId: string, plantIds: string[]): Promise<PlantAssignSummary> {
  const res = await fetch(`${BASE_URL}/schedules/assign-plants`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ seId, plantIds }),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as PlantAssignSummary;
}

/** #275 — resolve a draft's plant ids into the ticket ids `assign-batch` will commit. */
export async function apiAssignableTickets(plantIds: string[]): Promise<{ plantId: string; ticketIds: string[] }[]> {
  if (plantIds.length === 0) return [];
  const res = await fetch(`${BASE_URL}/schedules/assignable-tickets?plantIds=${plantIds.join(',')}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as { plantId: string; ticketIds: string[] }[];
}

/** One (engineer, tickets) lane of an `assign-batch` commit (#275). */
export interface AssignBatchLane {
  seId: string;
  ticketIds: string[];
}

export type AssignBatchSkipReason = 'NOT_FOUND' | 'OUT_OF_ZONE' | 'CONFLICT_DEFERRED' | 'LOST_RACE';

export interface AssignBatchLaneResult {
  seId: string;
  result: 'OK' | 'SE_NOT_FOUND' | 'LANE_FAILED';
  assigned: number;
  alreadyAssigned: number;
  skipped: { ticketId: string; reason: AssignBatchSkipReason }[];
  scheduleId?: string;
  batchIds: string[];
}

export interface AssignBatchResult {
  lanes: AssignBatchLaneResult[];
}

/**
 * #275 — the review-and-commit write: one transaction per lane, one result row per lane, a mandatory
 * reason recorded once per lane. `assignPlants` above still exists for the Device Detail panel; the
 * console commits through this endpoint so the review screen can show a real diff before anything is
 * written and so a lane that fails is reported without touching the others.
 */
export async function apiAssignBatch(reasonCode: string, lanes: AssignBatchLane[]): Promise<AssignBatchResult> {
  const res = await fetch(`${BASE_URL}/schedules/assign-batch`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ reasonCode, lanes }),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as AssignBatchResult;
}

/** #276 — the three ways Distribute can turn a selection into a plan. */
export type DistributeStrategy = 'COVERAGE_TIER' | 'CAPACITY_HEADROOM' | 'PLANT_WHOLE';

export interface DistributePlantStop {
  plantId: string;
  ticketIds: string[];
}
export interface DistributeLane {
  seId: string;
  plants: DistributePlantStop[];
}
export interface DistributeUnplaced {
  ticketId: string;
  plantId: string;
  reason: 'NO_COVERAGE' | 'ALL_DROPPED';
}
export interface DistributeResult {
  strategy: DistributeStrategy;
  targetDate: string;
  lanes: DistributeLane[];
  unplaced: DistributeUnplaced[];
  overCapacitySeIds: string[];
}

/**
 * #276 — Distribute: project several plants across several engineers before anything is written.
 * Built on the real selection engine (`COVERAGE_TIER`) or the same shared readiness read the
 * candidate column already uses (`CAPACITY_HEADROOM` / `PLANT_WHOLE`) — never a client-side copy of
 * either. The proposal lands in the draft, editable; nothing is written by this call.
 */
export async function apiDistributePreview(
  ticketIds: string[],
  engineerIds: string[],
  strategy: DistributeStrategy,
): Promise<DistributeResult> {
  const res = await fetch(`${BASE_URL}/schedules/distribute-preview`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ ticketIds, engineerIds, strategy }),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as DistributeResult;
}

export type OverrideCommand =
  | { action: 'REMOVE_TICKET'; ticketId: string; reasonCode: string; confirm?: boolean }
  | { action: 'DEFER_TICKET'; ticketId: string; deferredToDate: string; reasonCode: string; confirm?: boolean }
  | { action: 'REORDER'; stopSequence: number; reasonCode: string; confirm?: boolean }
  | { action: 'SWAP_SE'; newSeId: string; reasonCode: string; confirm?: boolean }
  | { action: 'REASSIGN'; ticketId: string; newSeId: string; reasonCode: string; confirm?: boolean }
  | { action: 'SPLIT_BATCH'; ticketIds: string[]; newSeId: string; reasonCode: string; confirm?: boolean };

export interface OverrideOk {
  result: 'OK';
  batchId: string;
  scheduleId: string;
  seId: string;
  status: string;
}

export interface OverrideConflict {
  code: 'OVERRIDE_ON_SITE_CONFLICT';
  message: string;
  ticketIds: string[];
}

/** Thrown on a 409 when an override targets work an SE holds ON_SITE on; carries the conflict payload
 *  so the caller can show the warning and re-submit with `confirm: true` + the mandatory reason. */
export class OverrideConflictError extends Error {
  constructor(public readonly conflict: OverrideConflict) {
    super(conflict.message);
    this.name = 'OverrideConflictError';
  }
}

export async function apiOverrideBatch(batchId: string, cmd: OverrideCommand): Promise<OverrideOk> {
  const res = await fetch(`${BASE_URL}/batches/${encodeURIComponent(batchId)}/override`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify(cmd),
  });
  if (res.status === 409) {
    throw new OverrideConflictError((await res.json()) as OverrideConflict);
  }
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as OverrideOk;
}

/** One side of a move, as the design's capacity bar reads it: `5/6 → 6/6` (#289). */
export interface OverrideLaneImpact {
  seId: string;
  seName: string | null;
  committed: number;
  after: number;
  /** Null when the engineer has no cap set — no denominator, and no over-capacity marking either. */
  dailyCapacity: number | null;
  overCapacity: boolean;
}

/**
 * Where the run that placed this ticket ranked the *target* engineer.
 *
 * Every field is nullable and **null means unknown, never "unranked"** — the ticket was placed by
 * hand, the run predates the trace, or the target was never in the candidate pool. A surface that
 * rendered a fabricated position would be read as the engine's opinion (#283's rule).
 */
export interface OverrideRankContext {
  ticketId: string;
  runId: string;
  processingRank: number | null;
  chosenSeId: string | null;
  targetPrecedenceRank: number | null;
  targetVerdict: string | null;
  targetDropReason: string | null;
}

/** What the move does to the target's route. Appended — never a reorder (#258 Q6's ordinal plan). */
export interface OverrideRouteImpact {
  targetScheduleId: string | null;
  appendedAsStop: number;
  joinsExistingStop: boolean;
  reordersExistingStops: false;
}

export interface OverrideImpactConflicts {
  /** The `CONFLICT_ON_SITE` gate — reads empty until `soft_states` exists (Issue 15). */
  onSite: string[];
  /** The `CONFLICT_DEFERRED` gate — tickets held to a future return date (#249). */
  deferred: string[];
}

export interface OverrideImpact {
  result: 'OK';
  action: 'REASSIGN' | 'SWAP_SE' | 'SPLIT_BATCH';
  batchId: string;
  plantId: string;
  plantName: string;
  ticketIds: string[];
  from: OverrideLaneImpact;
  to: OverrideLaneImpact;
  rank: OverrideRankContext | null;
  route: OverrideRouteImpact;
  conflicts: OverrideImpactConflicts;
}

/**
 * #289 — what the proposed override would do, before it is done.
 *
 * **The same body the confirm takes**, deliberately: an operator previews `{action, ticketId,
 * newSeId, reasonCode}` and confirms the identical object, so the preview and the write cannot drift
 * into two vocabularies. A `POST` because the body is a command — the endpoint writes nothing, takes
 * no lock and opens no run, pinned backend-side by a spec that counts rows.
 *
 * The single-lane actions (REMOVE / DEFER / REORDER) are a **400 `NOT_PROJECTABLE`**, not an empty
 * impact: "both lanes' capacity" has no meaning for them and zeros would read as "this move costs
 * nothing". Callers should not offer a preview for those; this throws if one does.
 */
export async function apiOverridePreview(batchId: string, cmd: OverrideCommand): Promise<OverrideImpact> {
  const res = await fetch(`${BASE_URL}/batches/${encodeURIComponent(batchId)}/override/preview`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as OverrideImpact;
}
