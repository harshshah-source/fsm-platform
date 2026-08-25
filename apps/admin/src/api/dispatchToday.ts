// Typed client for the Today's Dispatch cockpit (#284, serving the #282-approved Crew Deck).
// Read scope is server-side: a ZM receives their own zone only; CSM/OH name a zone.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

/**
 * A ticket as it sits on a stop.
 *
 * `addSource` is the provenance grammar's input (#283): `AUTO_DISPATCH` / `SYSTEM_CRITICAL` are the
 * engine, everything else is a person, and **null is unknown** — a row written before provenance
 * existed. `systemPlaced` is the server's own reading of it, so the client never has to re-derive the
 * one distinction #282 R2 forbids getting wrong.
 */
export interface TodayTicket {
  ticketId: string;
  sortOrder: number;
  slaBucket: string | null;
  companyTier: string | null;
  addSource: string | null;
  addedBy: string | null;
  addReason: string | null;
  coverageTypeAtAssign: string | null;
  systemPlaced: boolean;
  returnDueToday: boolean;
}

export interface TodayStop {
  batchId: string;
  stopSequence: number;
  plantId: string;
  plantName: string;
  status: string;
  runId: string | null;
  tickets: TodayTicket[];
}

export interface TodayEngineer {
  seId: string;
  name: string;
  coverageType: string;
  committed: number;
  dailyCapacity: number;
  overCapacity: boolean;
  availability: string;
  scheduleId: string | null;
  scheduleStatus: string | null;
  stops: TodayStop[];
}

export interface TodaySituation {
  placed: number;
  unassignable: number;
  held: number;
  criticalNeedsYou: number;
  overCapacity: number;
  changesToday: number;
}

export interface TodayRun {
  runId: string;
  status: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface TodayUnassignable {
  ticketId: string;
  deviceId: string | null;
  plantId: string | null;
  plantName: string | null;
  poolEmptyReason: string | null;
}

export interface TodayHold {
  ticketId: string;
  deviceId: string | null;
  plantName: string | null;
  heldUntil: string;
  expectedFrom: string | null;
  decidedBy: string | null;
}

export interface TodayEscalation {
  insertionId: string;
  ticketId: string;
  slaBucket: string | null;
  createdAt: string;
}

/**
 * #286 — this zone's same-day recovery state, or `null` when nothing crashed today.
 *
 * `EXHAUSTED` and `EXPIRED` are the two the operator has to act on: the first means the system tried
 * and gave up, the second that the field day ran out first. Both are days of work that will not happen
 * unless somebody does something, which is why they are on the page rather than only in a log.
 */
export interface TodayRecovery {
  state: string;
  attempts: number;
  markedAt: string;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export interface DispatchTodayView {
  operatingDay: string;
  zone: { zoneId: string; name: string };
  run: TodayRun | null;
  /** #286 — null on an ordinary day; set when this zone was owed a re-dispatch. */
  recovery: TodayRecovery | null;
  engineers: TodayEngineer[];
  situation: TodaySituation;
  rails: {
    unassignable: TodayUnassignable[];
    held: TodayHold[];
    /** `itemised: false` is the contract, not a placeholder: the engine counts this work and never
     *  lists it, so the rail renders a count and says so rather than implying a truncated list. */
    policyWithheld: { count: number; itemised: false };
  };
  escalations: TodayEscalation[];
}

export type ChangeKind = 'ADD' | 'REMOVE' | 'SWAP';

export interface DispatchChange {
  kind: ChangeKind;
  ticketId: string;
  actorId: string;
  at: string;
  reason: string | null;
  toSeId: string | null;
  fromSeId: string | null;
  via: string | null;
}

export interface DispatchChangesTodayView {
  operatingDay: string;
  zoneId: string;
  counts: { adds: number; removes: number; swaps: number; total: number };
  changes: DispatchChange[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new Error(body.code ?? body.message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export function apiDispatchToday(zoneId?: string): Promise<DispatchTodayView> {
  return get<DispatchTodayView>(`/dispatch/today${zoneId ? `?zoneId=${encodeURIComponent(zoneId)}` : ''}`);
}

export function apiDispatchChangesToday(zoneId?: string): Promise<DispatchChangesTodayView> {
  return get<DispatchChangesTodayView>(
    `/dispatch/changes-today${zoneId ? `?zoneId=${encodeURIComponent(zoneId)}` : ''}`,
  );
}
