// #238 — typed client for `/api/settings/assignment-threshold`, the governed SE-assignment threshold
// (how long a device must be silent before it becomes work for a Service Engineer).
//
// Read and set are open to the Operations Head and the CSM; lock, unlock and revert are the
// Operations Head's alone. The server resolves that authority and returns it on the view
// (`canEdit` / `canLock`), so this client never re-derives the rules from the session role — one
// place decides who may do what, and it is the same place that enforces it.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export interface ThresholdLock {
  locked: boolean;
  lockedAt: string | null;
  lockedBy: string | null;
  lockedByRole: string | null;
  lockReason: string | null;
}

export interface ThresholdChange {
  id: string;
  previousHours: number | null;
  newHours: number | null;
  changeType: 'SET' | 'REVERT' | 'LOCK' | 'UNLOCK';
  actorId: string;
  actorRole: string;
  reason: string | null;
  revertedFromId: string | null;
  createdAt: string;
}

export interface AssignmentThreshold {
  hours: number;
  options: number[];
  defaultHours: number;
  lock: ThresholdLock;
  writeRoles: string[];
  /** The Inactive definition, for the side-by-side the operator needs while choosing. */
  inactivityThresholdHours: number;
  canEdit: boolean;
  canLock: boolean;
  updatedAt: string | null;
  history: ThresholdChange[];
}

/** A refusal carries the server's own sentence — a locked key explains who locked it and why, which
 *  is a decision the reader should see rather than a generic "Forbidden". */
export type ThresholdWriteResult =
  | { result: 'OK'; threshold: AssignmentThreshold }
  | { result: 'REFUSED'; reason: string };

async function post(path: string, method: string, body: unknown): Promise<ThresholdWriteResult> {
  const res = await fetch(`${BASE_URL}/settings/assignment-threshold${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (res.ok) return { result: 'OK', threshold: payload as AssignmentThreshold };
  const reason = typeof payload?.reason === 'string' ? payload.reason : null;
  // 4xx from this surface is always a decision (invalid option, wrong role, locked key), never a
  // transport failure — surface it in place instead of throwing the page away.
  if (res.status >= 400 && res.status < 500) {
    return { result: 'REFUSED', reason: reason ?? 'That change was refused.' };
  }
  throw new Error(`REQUEST_FAILED_${res.status}`);
}

export async function getAssignmentThreshold(): Promise<AssignmentThreshold> {
  const res = await fetch(`${BASE_URL}/settings/assignment-threshold`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as AssignmentThreshold;
}

export const setAssignmentThreshold = (hours: number, reason: string): Promise<ThresholdWriteResult> =>
  post('', 'PUT', { hours, reason });

export const lockAssignmentThreshold = (reason: string): Promise<ThresholdWriteResult> =>
  post('/lock', 'POST', { reason });

export const unlockAssignmentThreshold = (reason: string): Promise<ThresholdWriteResult> =>
  post('/lock', 'DELETE', { reason });

export const revertAssignmentThreshold = (changeId: string, reason: string): Promise<ThresholdWriteResult> =>
  post('/revert', 'POST', { changeId, reason });
