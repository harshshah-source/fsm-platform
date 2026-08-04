// Typed client for the #213 dispatch-schedule surface — `/api/schedules/dispatch-schedule` (the
// Operations-Head-owned daily run time) and `/api/schedules/dispatch-run/in-flight` (what the
// Run-dispatch button needs to disable itself *before* someone presses it).

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export interface DispatchSchedule {
  cron: string;
  timeZone: string;
  /** ISO instant the job next fires — the confirmation that a change actually took. */
  nextFireAt: string;
}

/** A zone currently held by a run, as the backend reports it. */
export interface DispatchInFlight {
  zoneId: string;
  startedAt: string;
  trigger: string;
  actor: string;
}

/** A rejected expression comes back with the parser's own reason; show it rather than a generic error. */
export type SaveScheduleResult = { result: 'OK'; schedule: DispatchSchedule } | { result: 'INVALID'; reason: string };

export async function getDispatchSchedule(): Promise<DispatchSchedule> {
  const res = await fetch(`${BASE_URL}/schedules/dispatch-schedule`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as DispatchSchedule;
}

export async function putDispatchSchedule(cron: string): Promise<SaveScheduleResult> {
  const res = await fetch(`${BASE_URL}/schedules/dispatch-schedule`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ cron }),
  });
  const body = await res.json();
  if (res.ok) return { result: 'OK', schedule: body as DispatchSchedule };
  if (body?.code === 'INVALID_CRON_EXPRESSION') {
    return { result: 'INVALID', reason: String(body.reason ?? 'That is not a valid cron expression.') };
  }
  throw new Error(`REQUEST_FAILED_${res.status}`);
}

export async function getDispatchInFlight(): Promise<DispatchInFlight[]> {
  const res = await fetch(`${BASE_URL}/schedules/dispatch-run/in-flight`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  const body = (await res.json()) as { inFlight?: DispatchInFlight[] };
  // Defaulted rather than trusted: this read only ever *disables* a control, so a backend that predates
  // the endpoint (or any unexpected body) must degrade to "nothing running" instead of throwing and
  // taking the page down with it.
  return Array.isArray(body?.inFlight) ? body.inFlight : [];
}
