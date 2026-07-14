// Typed client for the ZM Batch-Schedule monitoring + override surface (Issue 13a backend / 13b UI).
// Mirrors the backend ZmScheduleQueryService view types; token comes from the same sessionStorage key
// AuthProvider writes. Monitoring only — there is no approval gate (CONTEXT.md Decisions §7).

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

function authHeaders(json = false): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

export const apiListSchedules = () => get<ScheduleRow[]>('/schedules');

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

/** Grouped Critical Work Queue one-click assign — creates a Formal Assignment (Issue 13b AC#6). */
export async function apiAssignTicket(ticketId: string, seId: string): Promise<AssignOk> {
  const res = await fetch(`${BASE_URL}/schedules/assign`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ ticketId, seId }),
  });
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
