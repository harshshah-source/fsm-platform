// Typed client for manager availability — the `role_unavailability` windows that drive the backup
// cascade (Issue 27, CONTEXT.md §15), and the two calls that put an acting session on the record
// (#339).
//
// Before #339 the platform could only ever *write* a window: `POST /role-unavailability` existed, no
// screen called it, and nothing could read one back or end one. A cover that cannot be seen or ended
// is not a control an operator can use — which is why the CSM acting gate this feeds could not be
// switched on until these three doors existed.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export interface UnavailabilityRow {
  id: string;
  role: string;
  zoneId: string | null;
  /** Resolved server-side — a settings table that says `3` makes the operator go and look it up. */
  zoneName: string | null;
  userId: string | null;
  windowStart: string;
  windowEnd: string | null;
  reason: string | null;
  createdByRole: string | null;
  /** In force right now — what the acting gate consults. */
  open: boolean;
}

export interface OpenWindowInput {
  role: string;
  zoneId?: number | null;
  windowStart: string;
  windowEnd?: string | null;
  reason?: string | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as T;
}

export async function listUnavailability(openOnly = false): Promise<UnavailabilityRow[]> {
  const qs = openOnly ? '?open=true' : '';
  return json<UnavailabilityRow[]>(await fetch(`${BASE_URL}/role-unavailability${qs}`, { headers: authHeaders() }));
}

export async function openUnavailability(body: OpenWindowInput): Promise<{ result: 'OK'; id: string }> {
  const res = await fetch(`${BASE_URL}/role-unavailability`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return json<{ result: 'OK'; id: string }>(res);
}

/** End a window now. The server stamps `window_end` rather than deleting: the cover is history. */
export async function endUnavailability(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/role-unavailability/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
}

/**
 * Record the start / end of an acting session (#339 AC5).
 *
 * The zone travels in `X-Acting-As-Zone` — the same header every acted-as request carries and the one
 * the backend audits from — so these are called only once the acting state has been written to
 * `sessionStorage`, never before. Both swallow their own failures: this is bookkeeping beside the
 * operator's action, not a gate on it (the gate is the backend guard, which has already run).
 */
export async function recordActingEntered(): Promise<void> {
  await post('/acting/enter', authHeaders());
}

export async function recordActingExited(zoneId: number): Promise<void> {
  // Exiting clears the stored zone first, so the header has to be spelled out here — otherwise the
  // row that says "this acting session ended" could not say which one.
  await post('/acting/exit', { ...authHeaders(), 'X-Acting-As-Zone': String(zoneId) });
}

async function post(path: string, headers: Record<string, string>): Promise<void> {
  try {
    await fetch(`${BASE_URL}${path}`, { method: 'POST', headers });
  } catch {
    // Deliberately silent — see the note above.
  }
}
