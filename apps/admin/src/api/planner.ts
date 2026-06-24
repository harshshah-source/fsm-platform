// Typed client for the SE Planner surface (Issue 14a backend / 14b grid UI). ZM-authored plant-visit
// intents (SE × plant × date), zone-scoped server-side. Token comes from the same sessionStorage key
// AuthProvider writes. The grid reads `/planner` + `/planner/plants`, writes via POST/DELETE `/planner`.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

function authHeaders(json = false): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

/** One plant-visit intent: SE assigned to visit a plant on a date. Mirrors backend `PlannerEntryView`. */
export interface PlannerEntry {
  id: string;
  seId: string;
  plantId: string;
  plannedDate: string; // YYYY-MM-DD
}

/** Zone-scoped plant for the picker + cell labels. Mirrors backend `PlannerPlantView`. */
export interface PlannerPlant {
  plantId: string;
  name: string;
  zoneId: string;
}

export async function apiListPlannerEntries(dateFrom: string, dateTo: string): Promise<PlannerEntry[]> {
  const qs = `?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}`;
  const res = await fetch(`${BASE_URL}/planner${qs}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as PlannerEntry[];
}

export async function apiListPlannerPlants(): Promise<PlannerPlant[]> {
  const res = await fetch(`${BASE_URL}/planner/plants`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as PlannerPlant[];
}

export async function apiCreatePlannerEntry(input: {
  seId: string;
  plantId: string;
  plannedDate: string;
}): Promise<PlannerEntry> {
  const res = await fetch(`${BASE_URL}/planner`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as PlannerEntry;
}

export async function apiDeletePlannerEntry(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/planner/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
}
